/**
 * The index daemon: one detached process per index file that owns the
 * writer lock, keeps the index open once, and serves every MCP client over a
 * Unix socket. Launched by `qmd mcp` with `QMD_DAEMON_INTERNAL=1`.
 *
 * Lifecycle: elect (atomic `daemon.pid`), take the writer lock, bind the
 * socket, open the store, serve connections; exit `QMD_DAEMON_IDLE_MS` after
 * the last client leaves, or on SIGTERM. Each connection is one `McpServer`
 * from the same factory the in-process server uses, driven by the SDK's
 * stdio transport over the socket, so tools behave exactly as before.
 */

import { chmodSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, statSync, renameSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createMcpServer, createInflightGate, openMcpStore } from "../mcp/server.js";
import type { QMDStore } from "../index.js";
import { ClientRegistry, type IsAlive } from "./clients.js";
import { readFirstLine } from "./hello-stream.js";
import { isProcessAlive, releasePidLock, tryAcquirePidLock, clearStalePidLock, type PidLockResult } from "./lock.js";
import {
  daemonPaths,
  encodeHello,
  envMs,
  parseClientHello,
  qmdPackageVersion,
  HELLO_PROTOCOL,
  type DaemonLockRecord,
  type DaemonPaths,
} from "./paths.js";
import { tryAcquireWriterLock, writerLockHeldMessage, type WriterLockHandle } from "./writer-lock.js";
import { CollectionWatcher, type WatchedCollection } from "./watcher.js";
import { LiveIndexer } from "./live-index.js";
import { parseControlRequest, encodeControl, type ControlRequest, type ControlEvent, type DaemonStatusReport } from "./control.js";
import { runCleanup } from "../store.js";
import type { LiveStatus } from "../mcp/server.js";

export const DEFAULT_IDLE_MS = 300_000;
export const DEFAULT_MAX_IDLE_MS = 1_800_000;
export const DEFAULT_SWEEP_MS = 30_000;
/** How long to wait for the optional client hello before serving the bytes as JSON-RPC. */
const CLIENT_HELLO_TIMEOUT_MS = 3000;
/** The log is truncated when it grows past this on start. */
const LOG_TRUNCATE_BYTES = 5 * 1024 * 1024;
/** After a graceful stop, force the exit if native handles keep the loop alive. */
const EXIT_BACKSTOP_MS = 2000;

export type DaemonOptions = {
  dbPath: string;
  idleMs?: number;
  maxIdleMs?: number;
  sweepMs?: number;
  version?: string;
  log?: (line: string) => void;
  isAlive?: IsAlive;
  /** Called after the store is open, before clients are served. */
  onReady?: (daemon: IndexDaemon) => void | Promise<void>;
  /** Watch collection roots for changes (default: unless `QMD_NO_WATCH=1`). */
  watch?: boolean;
  /** Embed after changes (default: unless `QMD_DAEMON_EMBED=0`). */
  embed?: boolean;
};

type ClientHandle = { handle: StdioServerHandle; socket: Socket };

export class IndexDaemon {
  readonly dbPath: string;
  readonly paths: DaemonPaths;
  readonly version: string;
  readonly clients: ClientRegistry<ClientHandle>;
  private readonly idleMs: number;
  private readonly maxIdleMs: number;
  private readonly sweepMs: number;
  private readonly log: (line: string) => void;
  private readonly isAlive: IsAlive;
  private server: Server | null = null;
  private store: QMDStore | null = null;
  private writerLock: WriterLockHandle | null = null;
  private readonly accepting = new Set<Socket>();
  private idleTimer: NodeJS.Timeout | null = null;
  private backstopTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopping: Promise<void> | null = null;
  private readonly inflight = createInflightGate();
  private indexer: LiveIndexer | null = null;
  private readonly watchers = new Map<string, CollectionWatcher>();
  private readonly watchEnabled: boolean;
  private readonly embedOption: boolean | undefined;
  private startedAt = 0;
  private resolveExited: (() => void) | null = null;
  /** Resolves once `stop` has finished its cleanup. */
  readonly exited: Promise<void> = new Promise((resolve) => { this.resolveExited = resolve; });

  constructor(options: DaemonOptions) {
    this.dbPath = options.dbPath;
    this.paths = daemonPaths(options.dbPath);
    this.version = options.version ?? qmdPackageVersion();
    this.idleMs = options.idleMs ?? envMs("QMD_DAEMON_IDLE_MS", DEFAULT_IDLE_MS);
    this.maxIdleMs = options.maxIdleMs ?? envMs("QMD_DAEMON_MAX_IDLE_MS", DEFAULT_MAX_IDLE_MS);
    this.sweepMs = options.sweepMs ?? envMs("QMD_DAEMON_SWEEP_MS", DEFAULT_SWEEP_MS);
    this.log = options.log ?? ((line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
    this.isAlive = options.isAlive ?? isProcessAlive;
    this.clients = new ClientRegistry<ClientHandle>();
    this.watchEnabled = options.watch ?? (process.env.QMD_NO_WATCH !== "1");
    this.embedOption = options.embed;
  }

  /** The indexer; null before `start` and after `stop`. */
  getIndexer(): LiveIndexer | null {
    return this.indexer;
  }

  /** Watcher states for `status`. */
  watcherStatus() {
    return [...this.watchers.values()].map((w) => w.status());
  }

  /** The store this daemon serves; null before `start` and after `stop`. */
  getStore(): QMDStore | null {
    return this.store;
  }

  /**
   * Elect, lock, bind, open. Resolves once the socket is listening and the
   * store is open. Throws when another daemon or writer owns the index; the
   * caller exits quietly in that case.
   */
  async start(onReady?: DaemonOptions["onReady"]): Promise<void> {
    mkdirSync(this.paths.dir, { recursive: true });
    const record: DaemonLockRecord = {
      pid: process.pid,
      mode: "daemon",
      startedAt: Date.now(),
      version: this.version,
      dbPath: this.dbPath,
      socketPath: this.paths.socketPath,
    };
    const election = this.elect(record);
    if (election.kind === "taken") {
      throw new Error(`another qmd daemon (PID ${election.existing?.pid ?? "unknown"}) serves ${this.dbPath}`);
    }

    const writer = tryAcquireWriterLock(this.dbPath, "daemon");
    if (writer.kind === "taken") {
      releasePidLock(this.paths.pidPath);
      throw new Error(writerLockHeldMessage(writer.holder, writer.lockPath));
    }
    this.writerLock = writer;

    try {
      this.server = await this.bind();
      this.store = await openMcpStore(this.dbPath);
      this.startedAt = record.startedAt;
      this.indexer = new LiveIndexer(this.store, { log: this.log, embed: this.embedOption });
      writeFileSync(this.paths.infoPath, JSON.stringify({
        pid: process.pid,
        dbPath: this.dbPath,
        socketPath: this.paths.socketPath,
        version: this.version,
        startedAt: record.startedAt,
      }, null, 2) + "\n", { mode: 0o600 });
    } catch (err) {
      await this.cleanupFiles();
      throw err;
    }

    this.log(`daemon listening on ${this.paths.socketPath} (pid ${process.pid}, qmd ${this.version}, index ${this.dbPath}); idle exit after ${this.idleMs} ms`);
    await onReady?.(this);
    this.startWatchers();
    // Catch up on edits made while no daemon ran. Sessions are served meanwhile.
    void this.indexer.reconcileAll().catch((err) => this.log(`start-up reconcile failed: ${err instanceof Error ? err.message : String(err)}`));
    // Nobody is connected yet: a daemon spawned by a launcher that then died
    // must still go away.
    this.armIdleTimer();
    this.startLivenessTimers();
    process.on("SIGTERM", () => { void this.stop("SIGTERM"); });
    process.on("SIGINT", () => { void this.stop("SIGINT"); });
  }

  /** Acquire `daemon.pid`; a dead or non-answering holder is cleared once. */
  private elect(record: DaemonLockRecord): PidLockResult<DaemonLockRecord> {
    let result = tryAcquirePidLock(this.paths.pidPath, record);
    if (result.kind === "taken" && (!result.existing || !this.isAlive(result.existing.pid))) {
      if (clearStalePidLock(this.paths.pidPath, result.raw)) {
        result = tryAcquirePidLock(this.paths.pidPath, record);
      }
    }
    return result;
  }

  private bind(): Promise<Server> {
    return new Promise((resolve, reject) => {
      // We hold daemon.pid, so no live daemon owns a socket at this path; a
      // leftover file from a killed daemon would make listen fail EADDRINUSE.
      if (process.platform !== "win32") {
        try { unlinkSync(this.paths.socketPath); } catch { /* none to remove */ }
      }
      const server = createServer((socket) => this.handleConnection(socket));
      server.once("error", reject);
      server.listen(this.paths.socketPath, () => {
        if (process.platform !== "win32") {
          try { chmodSync(this.paths.socketPath, 0o600); } catch { /* best-effort */ }
        }
        resolve(server);
      });
    });
  }

  private handleConnection(socket: Socket): void {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    this.accepting.add(socket);
    socket.once("close", () => this.accepting.delete(socket));
    socket.on("error", () => { /* reported through close */ });
    socket.write(encodeHello({ qmd: this.version, pid: process.pid, dbPath: this.dbPath, protocol: HELLO_PROTOCOL }));

    void readFirstLine(socket, CLIENT_HELLO_TIMEOUT_MS).then((first) => {
      // A probe (status, stop, a launcher checking the hello) reads our hello
      // and ends; it is not a client.
      if (this.stopping || socket.destroyed || socket.readableEnded || !this.store) {
        socket.destroy();
        return;
      }
      const control = first.line === null ? null : parseControlRequest(first.line);
      if (control) {
        void this.handleControl(socket, control);
        return;
      }
      const hello = first.line === null ? null : parseClientHello(first.line);
      if (first.line !== null && !hello) {
        // Not a hello: the line is the client's first JSON-RPC message.
        try { socket.unshift(Buffer.from(first.line + "\n", "utf8")); } catch { /* gone */ }
      }
      const store = this.store;
      const transport = new StdioServerTransport(socket, socket);
      const live = this.liveStatus();
      const handle = serveStdio(() => createMcpServer(store, this.inflight, live), { transport });
      const client: ClientHandle = { handle, socket };
      this.clients.add(client, hello ? { pid: hello.pid, hostPid: hello.hostPid } : null);
      this.disarmIdleTimer();
      this.log(`client connected (pid ${hello?.pid ?? "unknown"}, host ${hello?.hostPid ?? "unknown"}); clients=${this.clients.size}`);
      socket.on("data", () => this.clients.touch());
      socket.once("close", () => this.dropClient(client, "socket closed"));
      // serveStdio attached its listener; the stream was paused for the hello.
      socket.resume();
    });
  }

  private dropClient(client: ClientHandle, why: string): void {
    if (!this.clients.remove(client)) return;
    void client.handle.close().catch(() => {});
    this.log(`client left (${why}); clients=${this.clients.size}`);
    if (this.clients.size === 0) this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer || this.stopping || this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size > 0) {
        this.armIdleTimer();
        return;
      }
      void this.stop("idle timeout");
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private disarmIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private startLivenessTimers(): void {
    if (this.maxIdleMs > 0) {
      this.backstopTimer = setInterval(() => {
        this.reapDeadClients();
        if (this.clients.shouldBackstopExit(this.maxIdleMs, this.isAlive)) void this.stop("inactivity backstop");
      }, Math.min(this.maxIdleMs, 60_000));
      this.backstopTimer.unref?.();
    }
    if (this.sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.reapDeadClients(), this.sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Drop clients whose peer process is gone. Returns how many were dropped. */
  reapDeadClients(): number {
    const dead = this.clients.deadClients(this.isAlive);
    for (const entry of dead) {
      try { entry.handle.socket.destroy(); } catch { /* ignore */ }
      this.dropClient(entry.handle, `peer pid ${entry.peers?.pid ?? "?"} dead`);
    }
    return dead.length;
  }

  /** Graceful shutdown; idempotent. Resolves once files are cleaned and the exit is scheduled. */
  stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      for (const timer of [this.idleTimer, this.backstopTimer, this.sweepTimer]) {
        if (timer) clearTimeout(timer);
      }
      this.idleTimer = this.backstopTimer = this.sweepTimer = null;
      this.log(`shutting down (${reason}; clients=${this.clients.size})`);
      for (const watcher of this.watchers.values()) watcher.stop();
      this.watchers.clear();
      for (const entry of this.clients.entries()) {
        try { await entry.handle.handle.close(); } catch { /* best-effort */ }
        try { entry.handle.socket.destroy(); } catch { /* ignore */ }
      }
      for (const socket of this.accepting) socket.destroy();
      if (this.server) {
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = null;
      }
      await this.inflight.waitForIdle(5000);
      // Let a write in flight finish; the queue holds at most what the watchers queued.
      if (this.indexer) {
        await Promise.race([this.indexer.run("stop", async () => {}), new Promise((r) => setTimeout(r, 15_000))]);
        this.indexer = null;
      }
      if (this.store) {
        try { await this.store.close(); } catch (err) { this.log(`store close failed: ${err instanceof Error ? err.message : String(err)}`); }
        this.store = null;
      }
      await this.cleanupFiles();
      process.exitCode = 0;
      // node-llama-cpp's handles can hold the loop open after dispose.
      const backstop = setTimeout(() => process.exit(0), EXIT_BACKSTOP_MS);
      backstop.unref?.();
      this.resolveExited?.();
    })();
    return this.stopping;
  }

  /** One watcher per collection; a collection whose root cannot be watched is reported, not fatal. */
  private startWatchers(): void {
    if (!this.watchEnabled || !this.indexer) return;
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    for (const collection of this.indexer.collections()) {
      this.startWatcher(collection);
    }
  }

  private startWatcher(collection: WatchedCollection): void {
    const indexer = this.indexer!;
    const watcher = new CollectionWatcher(collection, (flush) => indexer.applyFlush(collection, flush).then(() => {}), { log: this.log });
    this.watchers.set(collection.name, watcher);
    if (watcher.start()) this.log(`watching ${collection.name} at ${collection.path} (${collection.pattern})`);
  }

  /** What the MCP tools read to flag results that are still being indexed. */
  private liveStatus(): LiveStatus {
    return {
      isPending: (collection, path) => this.watchers.get(collection)?.isPending(path) ?? false,
      pendingCount: () => [...this.watchers.values()].reduce((n, w) => n + w.status().pending, 0),
      report: () => this.statusReport(),
    };
  }

  private statusReport(): DaemonStatusReport {
    return {
      pid: process.pid,
      version: this.version,
      dbPath: this.dbPath,
      startedAt: this.startedAt,
      clients: this.clients.size,
      indexer: this.indexer?.state ?? { busy: null, lastReconcileAt: null, lastApplyAt: null, lastEmbedAt: null, lastError: null, queued: 0 },
      watchers: this.watcherStatus(),
      needsEmbedding: this.store?.internal.getHashesNeedingEmbedding() ?? 0,
    };
  }

  /** Serve one control request, then close the connection. */
  private async handleControl(socket: Socket, request: ControlRequest): Promise<void> {
    const send = (event: ControlEvent): void => {
      try { socket.write(encodeControl(event)); } catch { /* client gone */ }
    };
    const indexer = this.indexer;
    const store = this.store;
    socket.resume();
    try {
      if (!indexer || !store) throw new Error("the daemon is not ready");
      switch (request.op) {
        case "status":
          send({ event: "done", op: "status", status: this.statusReport() });
          break;
        case "update": {
          this.log(`control: update${request.collections ? ` ${request.collections.join(",")}` : ""}`);
          const summary = await indexer.reconcileAll({
            collections: request.collections,
            onProgress: (progress) => send({ event: "progress", progress }),
          });
          send({ event: "done", op: "update", summary });
          break;
        }
        case "embed": {
          this.log(`control: embed${request.collection ? ` ${request.collection}` : ""}${request.force ? " --force" : ""}`);
          if (request.force) {
            await indexer.run("clear embeddings", async () => { store.internal.clearAllEmbeddings(); });
          }
          const result = await indexer.embedPending(request.collection, (progress) => send({ event: "embed-progress", progress }));
          send({ event: "done", op: "embed", result });
          break;
        }
        case "reload": {
          this.log("control: reload config");
          const outcome = await indexer.reloadConfig((progress) => send({ event: "progress", progress }));
          this.startWatchers();
          send({ event: "done", op: "reload", ...outcome });
          break;
        }
        case "cleanup": {
          this.log("control: cleanup");
          const stats = await indexer.run("cleanup", async () => runCleanup(store.internal.db, {
            onVectorRepack: () => send({ event: "log", message: "Repacking the vector table..." }),
          }));
          send({ event: "done", op: "cleanup", stats });
          break;
        }
      }
    } catch (err) {
      send({ event: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      socket.end();
    }
  }

  private async cleanupFiles(): Promise<void> {
    this.writerLock?.release();
    this.writerLock = null;
    releasePidLock(this.paths.pidPath);
    for (const file of [this.paths.infoPath, ...(process.platform === "win32" ? [] : [this.paths.socketPath])]) {
      try { unlinkSync(file); } catch { /* already gone */ }
    }
  }
}

/** Keep the log from growing without bound across restarts. */
function openLog(logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true });
  try {
    if (statSync(logPath).size > LOG_TRUNCATE_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch { /* no log yet */ }
  return openSync(logPath, "a");
}

/**
 * Entry for the detached daemon process. Returns only when the daemon has
 * exited or refused to start; the CLI sets the exit code from the outcome.
 */
/**
 * Embedding contexts the daemon keeps while it embeds. `qmd embed` sizes its
 * pool from free VRAM (up to 8 contexts of about 150 MB each for the default
 * model) because it has a whole backlog to push through; the daemon mostly
 * embeds one or two changed files at a time and would hold that pool for the
 * five minutes until the models unload. Two contexts cover a save burst;
 * `QMD_EMBED_PARALLELISM` set by the user wins.
 */
export const DAEMON_EMBED_PARALLELISM = "2";

export async function runIndexDaemon(dbPath: string): Promise<number> {
  if (!process.env.QMD_EMBED_PARALLELISM?.trim()) process.env.QMD_EMBED_PARALLELISM = DAEMON_EMBED_PARALLELISM;
  const paths = daemonPaths(dbPath);
  mkdirSync(paths.dir, { recursive: true });
  const logFd = openLog(paths.logPath);
  const log = (line: string): void => {
    try { writeFileSync(logFd, `${new Date().toISOString()} ${line}\n`); } catch { /* log gone */ }
  };
  const daemon = new IndexDaemon({ dbPath, log });
  try {
    await daemon.start();
  } catch (err) {
    log(`not starting: ${err instanceof Error ? err.message : String(err)}`);
    closeSync(logFd);
    return 0;
  }
  await daemon.exited;
  closeSync(logFd);
  return 0;
}

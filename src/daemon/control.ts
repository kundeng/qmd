/**
 * What the CLI does to a daemon from outside: find it, describe it, stop it,
 * and hand it the index writes it would otherwise refuse while the daemon
 * holds the writer lock (`qmd update`, `qmd embed`, `qmd cleanup`, and a
 * config reload after `qmd collection add|remove|rename`).
 *
 * A control exchange rides the daemon socket: after the daemon's hello, the
 * client's first line is a control request instead of a client hello, and
 * the daemon answers with JSON lines (`progress` events, then one `done` or
 * `error`) and closes. Every action that signals a pid first proves the
 * daemon's identity through its hello, so a pid file left by a killed daemon
 * never gets a signal aimed at whatever process reuses the number.
 */

import { readFileSync, unlinkSync } from "node:fs";
import type { Socket } from "node:net";
import { connectToDaemon } from "./proxy.js";
import { daemonPaths, qmdPackageVersion, MAX_HELLO_LINE_BYTES, type DaemonHello } from "./paths.js";
import { decodePidLock, isProcessAlive, clearStalePidLock } from "./lock.js";
import type { EmbedProgress, EmbedResult, CleanupStats } from "../store.js";
import type { ReconcileProgress, ReconcileSummary, LiveIndexerState } from "./live-index.js";
import type { WatcherStatus } from "./watcher.js";

const TERM_WAIT_MS = 3000;
const KILL_WAIT_MS = 2000;

// ── Protocol ────────────────────────────────────────────────────────────────

export type ControlRequest =
  | { qmd_control: 1; op: "update"; collections?: string[] }
  | { qmd_control: 1; op: "embed"; collection?: string; force?: boolean }
  | { qmd_control: 1; op: "reload" }
  | { qmd_control: 1; op: "cleanup" }
  | { qmd_control: 1; op: "status" };

export type ControlOp = ControlRequest["op"];

export type DaemonStatusReport = {
  pid: number;
  version: string;
  dbPath: string;
  startedAt: number;
  clients: number;
  indexer: LiveIndexerState;
  watchers: WatcherStatus[];
  needsEmbedding: number;
};

export type ControlEvent =
  | { event: "progress"; progress: ReconcileProgress }
  | { event: "embed-progress"; progress: EmbedProgress }
  | { event: "log"; message: string }
  | { event: "done"; op: "update"; summary: ReconcileSummary }
  | { event: "done"; op: "embed"; result: EmbedResult | null }
  | { event: "done"; op: "reload"; added: string[]; removed: string[]; changed: string[]; removedDocuments: Record<string, number>; summary: ReconcileSummary | null }
  | { event: "done"; op: "cleanup"; stats: CleanupStats }
  | { event: "done"; op: "status"; status: DaemonStatusReport }
  | { event: "error"; message: string };

const OPS: readonly ControlOp[] = ["update", "embed", "reload", "cleanup", "status"];

/** Parse one line as a control request, or null when it is something else. */
export function parseControlRequest(line: string): ControlRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.qmd_control !== 1 || typeof o.op !== "string" || !OPS.includes(o.op as ControlOp)) return null;
  switch (o.op as ControlOp) {
    case "update":
      return { qmd_control: 1, op: "update", ...(Array.isArray(o.collections) ? { collections: o.collections.map(String) } : {}) };
    case "embed":
      return { qmd_control: 1, op: "embed", ...(typeof o.collection === "string" ? { collection: o.collection } : {}), ...(o.force === true ? { force: true } : {}) };
    case "reload":
    case "cleanup":
    case "status":
      return { qmd_control: 1, op: o.op as "reload" | "cleanup" | "status" };
  }
}

export function encodeControl(message: ControlRequest | ControlEvent): string {
  return JSON.stringify(message) + "\n";
}

/**
 * Send one control request to the daemon for `dbPath` and stream its events to
 * `onEvent`. Resolves with the `done` event, or throws when no daemon answers
 * or the daemon reports an error.
 */
export async function requestFromDaemon(dbPath: string, request: ControlRequest, onEvent?: (event: ControlEvent) => void): Promise<Extract<ControlEvent, { event: "done" }>> {
  const paths = daemonPaths(dbPath);
  const attempt = await connectToDaemon(paths.socketPath, { version: qmdPackageVersion(), dbPath });
  if ("outcome" in attempt) {
    throw new Error(attempt.outcome === "mismatch" ? `The running daemon cannot take this request: ${attempt.reason}.` : `No index daemon answered (${attempt.reason}).`);
  }
  return readControlEvents(attempt, request, onEvent);
}

function readControlEvents(socket: Socket, request: ControlRequest, onEvent?: (event: ControlEvent) => void): Promise<Extract<ControlEvent, { event: "done" }>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let event: ControlEvent;
        try {
          event = JSON.parse(line) as ControlEvent;
        } catch {
          continue;
        }
        if (event.event === "done") return finish(() => resolve(event));
        if (event.event === "error") return finish(() => reject(new Error(event.message)));
        onEvent?.(event);
      }
      if (buffer.length > 64 * MAX_HELLO_LINE_BYTES) finish(() => reject(new Error("daemon sent an oversized control line")));
    });
    socket.on("close", () => finish(() => reject(new Error("the daemon closed the connection before finishing"))));
    socket.on("error", (err) => finish(() => reject(err)));
    socket.write(encodeControl(request));
    socket.resume();
  });
}

// ── Discovery, status and stop ─────────────────────────────────────────────

export type DaemonProbe =
  | { state: "running"; hello: DaemonHello; startedAt: number | null }
  | { state: "stale"; pid: number | null }
  | { state: "none" };

/** Read `daemon.pid` and check the socket answers for this pid. */
export async function probeIndexDaemon(dbPath: string): Promise<DaemonProbe> {
  const paths = daemonPaths(dbPath);
  let raw: string | null = null;
  try {
    raw = readFileSync(paths.pidPath, "utf-8");
  } catch {
    return { state: "none" };
  }
  const record = decodePidLock(raw);
  const attempt = await connectToDaemon(paths.socketPath, { version: qmdPackageVersion(), dbPath });
  if ("outcome" in attempt) {
    if (attempt.outcome === "mismatch") {
      // A daemon of another version is still a daemon; report what it said.
      return { state: "running", hello: attempt.hello, startedAt: record?.startedAt ?? null };
    }
    return { state: "stale", pid: record?.pid ?? null };
  }
  attempt.destroy();
  return {
    state: "running",
    hello: { qmd: qmdPackageVersion(), pid: record?.pid ?? -1, dbPath, protocol: 1 },
    startedAt: record?.startedAt ?? null,
  };
}

/** Lines for `qmd status`, or null when nothing is running and nothing is stale. */
export async function describeIndexDaemon(dbPath: string): Promise<string[] | null> {
  const probe = await probeIndexDaemon(dbPath);
  if (probe.state === "none") return null;
  if (probe.state === "stale") {
    sweepDaemonFiles(dbPath);
    return null;
  }
  const up = probe.startedAt ? formatUptime(Date.now() - probe.startedAt) : "unknown uptime";
  const lines = [`running (PID ${probe.hello.pid}, qmd ${probe.hello.qmd}, up ${up})`];
  try {
    const done = await requestFromDaemon(dbPath, { qmd_control: 1, op: "status" });
    if (done.op === "status") {
      const s = done.status;
      lines.push(`${s.clients} client(s); ${s.watchers.filter((w) => w.watching).length}/${s.watchers.length} collection(s) watched${s.indexer.busy ? `; busy: ${s.indexer.busy}` : ""}`);
      for (const w of s.watchers) {
        if (w.degraded) lines.push(`${w.collection}: watching disabled: ${w.degraded}`);
        else if (w.pending > 0) lines.push(`${w.collection}: ${w.pending} change(s) pending`);
      }
      if (s.indexer.lastError) lines.push(`last indexing error: ${s.indexer.lastError}`);
    }
  } catch {
    // An older daemon answers no control requests; the first line stands.
  }
  return lines;
}

function sweepDaemonFiles(dbPath: string): void {
  const paths = daemonPaths(dbPath);
  clearStalePidLock(paths.pidPath, null);
  for (const file of [paths.infoPath, ...(process.platform === "win32" ? [] : [paths.socketPath])]) {
    try { unlinkSync(file); } catch { /* none */ }
  }
}

export type StopResult =
  | { outcome: "no-daemon"; message: string }
  | { outcome: "stopped" | "killed" | "still-running" | "cleaned"; message: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

/** SIGTERM the daemon for `dbPath` after proving it answers, SIGKILL if it lingers, then sweep its files. */
export async function stopIndexDaemon(dbPath: string): Promise<StopResult> {
  const probe = await probeIndexDaemon(dbPath);
  if (probe.state === "none") return { outcome: "no-daemon", message: "No index daemon is running." };
  if (probe.state === "stale") {
    sweepDaemonFiles(dbPath);
    return { outcome: "cleaned", message: `Cleaned up files of a daemon that was no longer running${probe.pid ? ` (PID ${probe.pid})` : ""}.` };
  }
  const pid = probe.hello.pid;
  try { process.kill(pid, "SIGTERM"); } catch { /* raced to exit */ }
  if (await waitForExit(pid, TERM_WAIT_MS)) return { outcome: "stopped", message: `Stopped index daemon (PID ${pid}).` };
  try { process.kill(pid, "SIGKILL"); } catch { /* raced */ }
  if (await waitForExit(pid, KILL_WAIT_MS)) {
    sweepDaemonFiles(dbPath);
    return { outcome: "killed", message: `Killed index daemon (PID ${pid}) after it ignored SIGTERM.` };
  }
  return { outcome: "still-running", message: `Index daemon (PID ${pid}) did not exit.` };
}

export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

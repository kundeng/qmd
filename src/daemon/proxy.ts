/**
 * The `qmd mcp` proxy: the process an MCP host spawns, piping the host's
 * stdio to the index daemon's socket.
 *
 * After one hello line proves the daemon speaks our version and serves our
 * index, the proxy parses nothing: every byte from stdin goes to the socket
 * and every byte from the socket goes to stdout, so server-initiated
 * requests and both protocol eras pass through unchanged. It exits when
 * either side closes, which is what tells the daemon one client left, and a
 * parent watchdog catches a host that died without closing our stdin.
 */

import { createConnection, type Socket } from "node:net";
import { EARLY_PPID } from "./early-ppid.js";
import { readFirstLine } from "./hello-stream.js";
import { encodeHello, envMs, parseDaemonHello, socketFileExists, HELLO_PROTOCOL, type DaemonHello } from "./paths.js";

/** How long to wait for the daemon's hello before treating the socket as dead. */
const HELLO_TIMEOUT_MS = 3000;
/** Default parent-liveness poll; `QMD_PPID_POLL_MS=0` disables the watchdog. */
export const DEFAULT_PPID_POLL_MS = 5000;

export type ProxyExpectation = { version: string; dbPath: string };

export type ProxyOutcome =
  /** No daemon answered, or its hello was unusable: the caller may elect one. */
  | { outcome: "no-daemon"; reason: string }
  /** A daemon answered but is not ours to use: the caller serves in-process. */
  | { outcome: "mismatch"; reason: string; hello: DaemonHello };

/**
 * Connect to `socketPath` and read the daemon hello. Resolves with the live
 * socket (hello consumed, tail unshifted, socket paused) or a reason not to use it.
 */
export async function connectToDaemon(socketPath: string, expected: ProxyExpectation): Promise<Socket | ProxyOutcome> {
  if (!socketFileExists(socketPath)) return { outcome: "no-daemon", reason: "no socket file" };
  const socket = createConnection(socketPath);
  // A listener for the socket's whole life: an unhandled 'error' would be an
  // uncaught exception, and the host would see only "transport closed".
  socket.on("error", () => {});
  const connected = await new Promise<string | null>((resolve) => {
    socket.once("connect", () => resolve(null));
    socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
  });
  if (connected !== null) {
    socket.destroy();
    return { outcome: "no-daemon", reason: connected };
  }
  const first = await readFirstLine(socket, HELLO_TIMEOUT_MS);
  const hello = first.line === null ? null : parseDaemonHello(first.line);
  if (!hello) {
    socket.destroy();
    return { outcome: "no-daemon", reason: first.line === null ? "no hello before timeout" : "hello was not a daemon hello" };
  }
  if (hello.protocol !== HELLO_PROTOCOL || hello.qmd !== expected.version) {
    socket.destroy();
    return { outcome: "mismatch", reason: `daemon is qmd ${hello.qmd} (protocol ${hello.protocol}); this is qmd ${expected.version} (protocol ${HELLO_PROTOCOL})`, hello };
  }
  if (hello.dbPath !== expected.dbPath) {
    socket.destroy();
    return { outcome: "mismatch", reason: `daemon serves ${hello.dbPath}, not ${expected.dbPath}`, hello };
  }
  return socket;
}

/** Announce our pids so the daemon's sweep can drop us if we die silently. */
export function sendClientHello(socket: Socket, pid: number = process.pid, hostPid: number | null = EARLY_PPID > 1 ? EARLY_PPID : null): void {
  try {
    socket.write(encodeHello({ qmd_client: 1, pid, hostPid }));
  } catch {
    // best-effort: the daemon falls back to the socket-close lifecycle
  }
}

/**
 * Exit when the parent that spawned us is gone. On POSIX a dead parent
 * reparents us, so `process.ppid` diverges from the early capture. Returns
 * the timer so a caller can stop it; null when disabled or already orphaned.
 */
export function startParentWatchdog(onLost: (reason: string) => void, pollMs: number = envMs("QMD_PPID_POLL_MS", DEFAULT_PPID_POLL_MS)): NodeJS.Timeout | null {
  if (pollMs <= 0 || EARLY_PPID <= 1) return null;
  const timer = setInterval(() => {
    if (process.ppid !== EARLY_PPID) onLost(`ppid ${EARLY_PPID} -> ${process.ppid}`);
  }, pollMs);
  timer.unref?.();
  return timer;
}

/** Pipe stdin to the socket and the socket to stdout until either side closes. */
export function pipeUntilClose(socket: Socket, stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    stdin.on("data", (chunk: Buffer) => {
      try { socket.write(chunk); } catch { /* the close path reports it */ }
    });
    stdin.on("end", () => {
      try { socket.end(); } catch { /* ignore */ }
      finish();
    });
    const teardown = (): void => {
      try { stdin.destroy(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      finish();
    };
    stdin.on("close", teardown);
    stdin.on("error", teardown);
    socket.on("data", (chunk: Buffer) => {
      try { stdout.write(chunk); } catch { /* ignore */ }
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", finish);
    socket.resume();
  });
}

/**
 * Serve this host through the daemon on `socket` until the session ends,
 * then exit. Only returns by exiting the process.
 */
export async function runProxy(socket: Socket, log: (line: string) => void): Promise<never> {
  sendClientHello(socket);
  startParentWatchdog((reason) => {
    log(`qmd mcp: parent process exited (${reason}); shutting down.`);
    try { socket.destroy(); } catch { /* ignore */ }
    process.exit(0);
  });
  await pipeUntilClose(socket);
  // The pipe is the proxy's whole job; stdin's listener would otherwise keep
  // the loop alive after the host left.
  process.exit(0);
}

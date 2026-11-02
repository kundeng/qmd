/**
 * How `qmd mcp` finds or starts the daemon for its index, and when it serves
 * in-process instead.
 */

import { openSync, closeSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { Socket } from "node:net";
import { connectToDaemon, runProxy, type ProxyOutcome } from "./proxy.js";
import { daemonOptOut, daemonPaths, qmdPackageVersion } from "./paths.js";
import { decodePidLock, isProcessAlive } from "./lock.js";

/** How long a launcher waits for a freshly spawned daemon to bind. */
const SPAWN_WAIT_MS = 6000;
const SPAWN_POLL_MS = 25;

export type LaunchOptions = {
  dbPath: string;
  /** The CLI entry (`src/cli/qmd.ts` or `dist/cli/qmd.js`), re-invoked as the daemon. */
  cliEntry: string;
  /** Global flags the daemon must inherit, such as `--index <name>`. */
  cliArgs: string[];
  /** Serves this host in-process when no daemon can be used. */
  inProcess: () => Promise<void>;
  log?: (line: string) => void;
};

/** Spawn the detached daemon for `dbPath`. Its stderr goes to the daemon log. */
export function spawnDaemon(options: Pick<LaunchOptions, "dbPath" | "cliEntry" | "cliArgs">): number | undefined {
  const paths = daemonPaths(options.dbPath);
  mkdirSync(paths.dir, { recursive: true });
  const logFd = openSync(paths.logPath, "a");
  // A source checkout runs through tsx exactly as `qmd mcp --http --daemon` does.
  const args = options.cliEntry.endsWith(".ts")
    ? ["--import", join(dirname(options.cliEntry), "..", "..", "node_modules", "tsx", "dist", "esm", "index.mjs"), options.cliEntry, ...options.cliArgs, "mcp"]
    : [options.cliEntry, ...options.cliArgs, "mcp"];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: process.cwd(),
    env: {
      ...process.env,
      QMD_DAEMON_INTERNAL: "1",
      // The resolved index, so the daemon does not depend on re-reading flags.
      INDEX_PATH: options.dbPath,
    },
  });
  child.unref();
  closeSync(logFd);
  return child.pid;
}

/** Whether `daemon.pid` names a live process, meaning a daemon is up or starting. */
export function daemonAppearsStarting(pidPath: string): boolean {
  try {
    const record = decodePidLock(readFileSync(pidPath, "utf-8"));
    return !!record && isProcessAlive(record.pid);
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Serve one MCP host: through the shared daemon when possible, otherwise
 * in-process. Resolves only when serving in-process ends; the proxy path
 * exits the process itself.
 */
export async function startMcpStdio(options: LaunchOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (daemonOptOut()) return options.inProcess();

  const paths = daemonPaths(options.dbPath);
  const expected = { version: qmdPackageVersion(), dbPath: options.dbPath };

  let attempt: Socket | ProxyOutcome = await connectToDaemon(paths.socketPath, expected);
  if (isSocket(attempt)) return runProxy(attempt, log);
  if (attempt.outcome === "mismatch") {
    log(`qmd mcp: ${attempt.reason}; serving this session in-process.`);
    return options.inProcess();
  }

  // No daemon answered. Spawn one unless a live pid already holds daemon.pid
  // (another launcher's daemon is binding right now), then wait for the bind.
  if (!daemonAppearsStarting(paths.pidPath)) {
    spawnDaemon(options);
  }
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(SPAWN_POLL_MS);
    attempt = await connectToDaemon(paths.socketPath, expected);
    if (isSocket(attempt)) return runProxy(attempt, log);
    if (attempt.outcome === "mismatch") {
      log(`qmd mcp: ${attempt.reason}; serving this session in-process.`);
      return options.inProcess();
    }
  }
  log(`qmd mcp: no daemon answered on ${paths.socketPath} within ${SPAWN_WAIT_MS} ms; serving this session in-process.`);
  return options.inProcess();
}

function isSocket(value: Socket | ProxyOutcome): value is Socket {
  return typeof (value as Socket).write === "function";
}

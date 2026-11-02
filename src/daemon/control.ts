/**
 * What the CLI does to a daemon from outside: find it, describe it, stop it.
 * Every action proves the daemon's identity through its hello before acting
 * on a pid, so a pid file left by a killed daemon never gets a signal aimed at
 * whatever process reuses the number.
 */

import { readFileSync } from "node:fs";
import { connectToDaemon } from "./proxy.js";
import { daemonPaths, qmdPackageVersion, type DaemonHello } from "./paths.js";
import { decodePidLock, isProcessAlive, clearStalePidLock } from "./lock.js";
import { unlinkSync } from "node:fs";

const TERM_WAIT_MS = 3000;
const KILL_WAIT_MS = 2000;

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

/** One line for `qmd status`, or null when nothing is running and nothing is stale. */
export async function describeIndexDaemon(dbPath: string): Promise<string | null> {
  const probe = await probeIndexDaemon(dbPath);
  if (probe.state === "none") return null;
  if (probe.state === "stale") {
    const paths = daemonPaths(dbPath);
    clearStalePidLock(paths.pidPath, null);
    try { unlinkSync(paths.infoPath); } catch { /* none */ }
    return null;
  }
  const up = probe.startedAt ? formatUptime(Date.now() - probe.startedAt) : "unknown uptime";
  return `running (PID ${probe.hello.pid}, qmd ${probe.hello.qmd}, up ${up})`;
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
  const paths = daemonPaths(dbPath);
  const probe = await probeIndexDaemon(dbPath);
  if (probe.state === "none") return { outcome: "no-daemon", message: "No index daemon is running." };
  if (probe.state === "stale") {
    clearStalePidLock(paths.pidPath, null);
    for (const file of [paths.infoPath, paths.socketPath]) {
      try { unlinkSync(file); } catch { /* none */ }
    }
    return { outcome: "cleaned", message: `Cleaned up files of a daemon that was no longer running${probe.pid ? ` (PID ${probe.pid})` : ""}.` };
  }
  const pid = probe.hello.pid;
  try { process.kill(pid, "SIGTERM"); } catch { /* raced to exit */ }
  if (await waitForExit(pid, TERM_WAIT_MS)) return { outcome: "stopped", message: `Stopped index daemon (PID ${pid}).` };
  try { process.kill(pid, "SIGKILL"); } catch { /* raced */ }
  if (await waitForExit(pid, KILL_WAIT_MS)) {
    clearStalePidLock(paths.pidPath, null);
    for (const file of [paths.infoPath, paths.socketPath]) {
      try { unlinkSync(file); } catch { /* none */ }
    }
    return { outcome: "killed", message: `Killed index daemon (PID ${pid}) after it ignored SIGTERM.` };
  }
  return { outcome: "still-running", message: `Index daemon (PID ${pid}) did not exit.` };
}

function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Where a daemon's runtime files live, and the two hello lines it speaks.
 *
 * One daemon serves one index file. Its rendezvous key is a hash of the index
 * path, and everything a launcher needs to find it sits in one directory under
 * the qmd cache: never beside a project index, which may live in a synced
 * folder where a socket or pid file does not belong.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qmdHomedir } from "../paths.js";
import type { PidLockRecord } from "./lock.js";

/** Wire protocol of the hello lines; bump when their shape changes. */
export const HELLO_PROTOCOL = 1;

/** A hello line longer than this is not a hello. */
export const MAX_HELLO_LINE_BYTES = 4096;

/** `sun_path` is 104 bytes on macOS; keep a margin for the file name. */
const SOCKET_PATH_LIMIT = 100;

/** The daemon's first line on every connection. */
export type DaemonHello = {
  qmd: string;
  pid: number;
  dbPath: string;
  protocol: number;
};

/** The proxy's optional first line, so the daemon can sweep dead peers by pid. */
export type ClientHello = {
  qmd_client: 1;
  pid: number;
  hostPid: number | null;
};

/** The record in `daemon.pid`. */
export type DaemonLockRecord = PidLockRecord & {
  mode: "daemon";
  version: string;
  dbPath: string;
  socketPath: string;
};

export type DaemonPaths = {
  dir: string;
  pidPath: string;
  socketPath: string;
  logPath: string;
  /** `{ dbPath, configPath, startedAt, pid }` written by the daemon for listing. */
  infoPath: string;
};

/** `$XDG_CACHE_HOME/qmd` or `~/.cache/qmd`, as `getDefaultDbPath` resolves it. */
export function qmdCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || resolve(qmdHomedir(), ".cache");
  return resolve(base, "qmd");
}

/** Canonical spelling of an index path: realpath when it exists, else resolved. */
export function canonicalDbPath(dbPath: string): string {
  try {
    return realpathSync(dbPath);
  } catch {
    // The index may not exist yet; its parent usually does.
    try {
      return join(realpathSync(dirname(dbPath)), dbPath.split(/[\\/]/).pop() ?? dbPath);
    } catch {
      return resolve(dbPath);
    }
  }
}

/** Sixteen hex characters that name one index across processes. */
export function indexKey(dbPath: string): string {
  return createHash("sha256").update(canonicalDbPath(dbPath)).digest("hex").slice(0, 16);
}

export function daemonPaths(dbPath: string): DaemonPaths {
  const key = indexKey(dbPath);
  const dir = join(qmdCacheDir(), "run", key);
  const inDir = join(dir, "daemon.sock");
  // A home directory deep enough to push the socket past the limit falls back
  // to the temp dir, still keyed by the index so daemon and proxy agree.
  const socketPath = inDir.length > SOCKET_PATH_LIMIT ? join(tmpdir(), `qmd-${key}.sock`) : inDir;
  return {
    dir,
    pidPath: join(dir, "daemon.pid"),
    socketPath,
    logPath: join(dir, "daemon.log"),
    infoPath: join(dir, "index.json"),
  };
}

/** The qmd package version, read from package.json beside `dist/` or `src/`. */
export function qmdPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function encodeHello(hello: DaemonHello | ClientHello): string {
  return JSON.stringify(hello) + "\n";
}

export function parseDaemonHello(line: string): DaemonHello | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.qmd !== "string" || typeof o.pid !== "number" || typeof o.dbPath !== "string" || typeof o.protocol !== "number") {
    return null;
  }
  return { qmd: o.qmd, pid: o.pid, dbPath: o.dbPath, protocol: o.protocol };
}

export function parseClientHello(line: string): ClientHello | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.qmd_client !== 1 || typeof o.pid !== "number") return null;
  return { qmd_client: 1, pid: o.pid, hostPid: typeof o.hostPid === "number" ? o.hostPid : null };
}

/** Whether a socket file exists; on Windows a named pipe has no file. */
export function socketFileExists(socketPath: string): boolean {
  return process.platform === "win32" || existsSync(socketPath);
}

/** A positive integer from an env var, else the default (0 means "off" where documented). */
export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** `QMD_NO_DAEMON=1` (or any value other than 0/false/off) serves in-process. */
export function daemonOptOut(): boolean {
  const raw = process.env.QMD_NO_DAEMON;
  if (raw === undefined) return false;
  return !["", "0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

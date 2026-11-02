/**
 * The index writer lock: one process may change an index at a time.
 *
 * `qmd update`, `qmd embed`, `qmd collection add|remove|rename`, `qmd cleanup`
 * and the index daemon each take it for as long as they write. SQLite's
 * busy timeout already serializes their statements, but two scans or an
 * update racing an embed still interleave at batch boundaries and leave the
 * second one reporting counts the first one invalidated; the lock makes the
 * second one say who is writing instead. Generalizes the embed-only lock
 * (#825) and keeps its pid-identity recovery: a lock whose pid is dead, or
 * alive but not a qmd process, is cleared and taken.
 *
 * The lock file sits beside the index, where `.qmd-embed.lock` sat.
 */

import { dirname, join } from "node:path";
import { isQmdMcpPid } from "../cli/mcp-pid.js";
import {
  clearStalePidLock,
  releasePidLock,
  tryAcquirePidLock,
  decodePidLock,
  type PidLockRecord,
} from "./lock.js";
import { readFileSync } from "node:fs";

export type WriterMode = "update" | "embed" | "collection" | "cleanup" | "daemon";

export type WriterLockRecord = PidLockRecord & { mode: WriterMode | string };

export type WriterLockHandle = {
  kind: "acquired";
  lockPath: string;
  record: WriterLockRecord;
  /** Idempotent; unlinks the file only while it still names this process. */
  release: () => void;
};

export type WriterLockTaken = {
  kind: "taken";
  lockPath: string;
  /** The live holder's record, or null when the file was unreadable. */
  holder: WriterLockRecord | null;
};

/** Lock file sibling to the index database. */
export function writerLockPathForDb(dbPath: string): string {
  return join(dirname(dbPath), ".qmd-writer.lock");
}

/** True if `pid` is this process or a live process whose command line is a qmd invocation. */
export function isLiveWriterLockHolder(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  return isQmdMcpPid(pid);
}

/**
 * Take the writer lock for `dbPath` in `mode`. A lock held by a dead or
 * non-qmd pid is cleared and retried once; a live qmd holder is reported.
 */
export function tryAcquireWriterLock(dbPath: string, mode: WriterMode): WriterLockHandle | WriterLockTaken {
  const lockPath = writerLockPathForDb(dbPath);
  const record: WriterLockRecord = { pid: process.pid, mode, startedAt: Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = tryAcquirePidLock(lockPath, record);
    if (result.kind === "acquired") {
      let released = false;
      return {
        kind: "acquired",
        lockPath,
        record,
        release: () => {
          if (released) return;
          released = true;
          releasePidLock(lockPath);
        },
      };
    }
    if (result.existing && isLiveWriterLockHolder(result.existing.pid)) {
      return { kind: "taken", lockPath, holder: result.existing };
    }
    // Dead, recycled or unreadable holder: compare-and-delete, then retry.
    if (!clearStalePidLock(lockPath, result.raw)) {
      return { kind: "taken", lockPath, holder: readWriterLock(dbPath) };
    }
  }
  return { kind: "taken", lockPath, holder: readWriterLock(dbPath) };
}

/** The current record without acquiring, or null when no lock file exists. */
export function readWriterLock(dbPath: string): WriterLockRecord | null {
  try {
    return decodePidLock(readFileSync(writerLockPathForDb(dbPath), "utf-8"));
  } catch {
    return null;
  }
}

/** One sentence naming the holder and how to recover from a stale file. */
export function writerLockHeldMessage(holder: WriterLockRecord | null, lockPath: string): string {
  const who = holder && holder.pid > 0
    ? `qmd ${holder.mode} (PID ${holder.pid})`
    : "another qmd process";
  return `The index is being written by ${who}. Wait for it to finish, or stop it, then run this command again. ` +
    `If no such process exists, delete ${lockPath}.`;
}

/** Message when `qmd embed` finds another embed running (#825); the embed is skipped, not failed. */
export const EMBED_LOCK_BUSY_MESSAGE =
  "Another embed process is already running. Skipping.";

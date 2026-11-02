/**
 * Pid-file locks shared by the writer lock and the daemon election.
 *
 * A lock is a small JSON record in a file. It is created in one atomic step
 * that already holds the complete record: the record is written to a private
 * temp file and hard-linked into place, and `link()` fails with EEXIST when
 * the target exists. A loser therefore never reads an empty or half-written
 * file, which is what let a third racing process delete a live holder's lock
 * in the design this is ported from (codegraph #411). Filesystems without
 * hard links (ExFAT, some network mounts) fall back to an exclusive create,
 * which keeps "first writer wins" and reopens only a microsecond empty-file
 * window.
 *
 * A stale lock is removed by compare-and-delete: the caller passes the raw
 * contents it inspected, and the file is unlinked only while it still holds
 * exactly those bytes, so a lock a new holder took in the meantime survives.
 */

import { closeSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** The record every pid lock holds. Callers may add fields. */
export type PidLockRecord = {
  pid: number;
  /** What the holder is doing, for messages: "embed", "update", "daemon", ... */
  mode: string;
  /** Epoch ms when the lock was taken. */
  startedAt: number;
};

export type PidLockResult<R extends PidLockRecord> =
  | { kind: "acquired"; pidPath: string; record: R }
  | { kind: "taken"; pidPath: string; existing: PidLockRecord | null; raw: string | null };

/** `kill(pid, 0)` liveness. EPERM means the process exists but is not ours, which is alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function encodePidLock(record: PidLockRecord): string {
  return JSON.stringify(record) + "\n";
}

/**
 * Parse a lock file. A plain decimal pid (the format `.qmd-embed.lock` used
 * before this module) decodes as mode "unknown" so an old file is still a
 * holder to check, never a corrupt file to delete blindly.
 */
export function decodePidLock(raw: string): PidLockRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<PidLockRecord>;
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.pid) && typeof parsed.mode === "string") {
      return {
        ...parsed,
        pid: parsed.pid as number,
        mode: parsed.mode,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
    }
  } catch {
    // not JSON: fall through to the plain-pid form
  }
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? { pid, mode: "unknown", startedAt: 0 } : null;
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as NodeJS.ErrnoException).code)
    : undefined;
}

/** Exclusive-create fallback for filesystems where `link()` is unsupported. */
function acquireViaExclusiveOpen(pidPath: string, contents: string): boolean {
  let fd: number;
  try {
    fd = openSync(pidPath, "wx", 0o600);
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Create `pidPath` atomically with `record` already in it. Returns whether
 * this process acquired the lock, and otherwise the holder's record as read
 * from the complete file.
 */
export function tryAcquirePidLock<R extends PidLockRecord>(pidPath: string, record: R): PidLockResult<R> {
  mkdirSync(dirname(pidPath), { recursive: true });
  const contents = encodePidLock(record);
  // Pid-scoped temp name: racing candidates never collide on it.
  const tmp = `${pidPath}.${process.pid}.tmp`;
  let acquired = false;
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    try {
      linkSync(tmp, pidPath);
      acquired = true;
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") {
        // link() unsupported here (ENOTSUP, EPERM, EISDIR by platform); the
        // temp write proved the directory writable, so exclusive-create
        // is a valid substitute. Its EEXIST means taken; anything else throws.
        acquired = acquireViaExclusiveOpen(pidPath, contents);
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
  if (acquired) return { kind: "acquired", pidPath, record };

  let raw: string | null = null;
  let existing: PidLockRecord | null = null;
  try {
    raw = readFileSync(pidPath, "utf-8");
    existing = decodePidLock(raw);
  } catch {
    // unreadable: treat as a malformed holder
  }
  return { kind: "taken", pidPath, existing, raw };
}

/**
 * Remove a lock the caller has judged stale. The file is re-read first and
 * left alone when it no longer holds `expectedRaw`, so a holder that took
 * over since the caller looked is never disturbed. Returns true when the
 * file is gone afterwards.
 */
export function clearStalePidLock(pidPath: string, expectedRaw: string | null): boolean {
  try {
    const raw = readFileSync(pidPath, "utf-8");
    if (expectedRaw !== null && raw !== expectedRaw) return false;
    unlinkSync(pidPath);
    return true;
  } catch (err) {
    return errnoCode(err) === "ENOENT";
  }
}

/** Unlink `pidPath` only while its record still names `pid` (default: this process). */
export function releasePidLock(pidPath: string, pid: number = process.pid): void {
  try {
    const record = decodePidLock(readFileSync(pidPath, "utf-8"));
    if (record && record.pid === pid) unlinkSync(pidPath);
  } catch {
    // missing or unreadable: nothing of ours to release
  }
}

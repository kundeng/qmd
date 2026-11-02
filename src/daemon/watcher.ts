/**
 * One file watcher per collection root, feeding the live indexer.
 *
 * Node's `fs.watch` with `recursive: true` is one FSEvents stream on macOS
 * and one ReadDirectoryChangesW handle on Windows, so watching a tree costs a
 * constant number of descriptors however many files it holds. Linux has
 * supported the recursive form since Node 20; a platform that throws
 * `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` gets one watch per directory instead,
 * which is O(directories) and never O(files).
 *
 * Events are coalesced into a pending set keyed by the collection-relative
 * path and flushed after a quiet window: 2 s by default, 300 ms when at most
 * two files are pending so a single save shows up almost at once. A burst
 * past 500 files, or an event naming a directory, asks for a full collection
 * scan instead, which the `file_sync_state` fast path keeps cheap.
 */

import { existsSync, readdirSync, statSync, watch, type WatchEventType } from "node:fs";
import { join, relative } from "node:path";
import picomatch from "picomatch";
import { collectionIgnoreGlobs, isHiddenRelativePath, normalizePathSeparators, splitGlobMask, REINDEX_EXCLUDED_DIRS } from "../store.js";
import { envMs } from "./paths.js";

export const DEFAULT_DEBOUNCE_MS = 2000;
export const QUICK_SYNC_QUIET_MS = 300;
export const QUICK_SYNC_MAX_PENDING = 2;
export const FULL_SCAN_ABOVE_PENDING = 500;
/** Linux per-directory mode stops adding watches past this many directories. */
export const MAX_DIR_WATCHES = 50_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_RETRY_BACKOFF_MS = 30_000;

export type WatchedCollection = {
  name: string;
  /** Absolute root, as configured (resolved by the caller). */
  path: string;
  pattern: string;
  ignore?: string[];
};

/** What one flush asks the indexer to do. */
export type WatchFlush =
  | { kind: "files"; paths: string[]; prefixes: string[] }
  | { kind: "full"; reason: string };

/** The part of `fs.watch` the watcher uses; tests inject a fake with this shape. */
export type WatchImpl = (
  path: string,
  options: { recursive?: boolean; persistent?: boolean },
  listener: (event: WatchEventType, filename: string | Buffer | null) => void,
) => WatchHandle;

export type WatchHandle = {
  close(): void;
  on(event: "error", listener: (err: unknown) => void): unknown;
};

export type WatcherOptions = {
  debounceMs?: number;
  quickMs?: number;
  log?: (line: string) => void;
  /** Injected `fs.watch` for tests. */
  watchImpl?: WatchImpl;
};

export type WatcherStatus = {
  collection: string;
  watching: boolean;
  pending: number;
  degraded: string | null;
  lastFlushAt: number | null;
  lastError: string | null;
};

function errnoCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
}

export class CollectionWatcher {
  readonly collection: WatchedCollection;
  /** Relative path → ms when the watcher last saw it change. */
  readonly pending = new Map<string, number>();
  /** Relative paths that vanished without matching the pattern: likely directories. */
  private readonly pendingPrefixes = new Set<string>();
  private needsFullScan: string | null = null;
  private recursiveWatcher: WatchHandle | null = null;
  private readonly dirWatchers = new Map<string, WatchHandle>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private flushStartedMs = 0;
  private consecutiveFailures = 0;
  private stopped = false;
  degradedReason: string | null = null;
  lastFlushAt: number | null = null;
  lastError: string | null = null;
  private readonly debounceMs: number;
  private readonly quickMs: number;
  private readonly log: (line: string) => void;
  private readonly watchImpl: WatchImpl;
  private readonly matches: (relativePath: string) => boolean;
  private readonly ignored: (relativePath: string) => boolean;

  constructor(
    collection: WatchedCollection,
    private readonly onFlush: (flush: WatchFlush) => Promise<void>,
    options: WatcherOptions = {},
  ) {
    this.collection = collection;
    this.debounceMs = options.debounceMs ?? envMs("QMD_WATCH_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS);
    this.quickMs = options.quickMs ?? Math.min(QUICK_SYNC_QUIET_MS, this.debounceMs);
    this.log = options.log ?? (() => {});
    this.watchImpl = options.watchImpl ?? (watch as WatchImpl);
    this.matches = picomatch(splitGlobMask(collection.pattern));
    this.ignored = picomatch(collectionIgnoreGlobs(collection.ignore), { dot: true });
  }

  /** Install the OS watch. Returns false, with `degradedReason` set, when it cannot. */
  start(): boolean {
    if (this.recursiveWatcher || this.dirWatchers.size > 0) return true;
    this.stopped = false;
    if (!existsSync(this.collection.path)) {
      this.degrade(`collection root ${this.collection.path} does not exist`);
      return false;
    }
    try {
      this.recursiveWatcher = this.watchImpl(this.collection.path, { recursive: true, persistent: true }, (event, filename) => {
        this.onEvent(event, filename === null ? null : String(filename));
      });
      this.recursiveWatcher.on("error", (err) => this.onWatchError(err));
      return true;
    } catch (err) {
      if (errnoCode(err) !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
        this.degrade(describeWatchError(err));
        return false;
      }
    }
    // Per-directory fallback.
    try {
      this.watchDirectoryTree(this.collection.path);
      return this.dirWatchers.size > 0;
    } catch (err) {
      this.degrade(describeWatchError(err));
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.recursiveWatcher?.close();
    this.recursiveWatcher = null;
    for (const watcher of this.dirWatchers.values()) watcher.close();
    this.dirWatchers.clear();
  }

  status(): WatcherStatus {
    return {
      collection: this.collection.name,
      watching: !this.stopped && this.degradedReason === null && (this.recursiveWatcher !== null || this.dirWatchers.size > 0),
      pending: this.pending.size + this.pendingPrefixes.size + (this.needsFullScan ? 1 : 0),
      degraded: this.degradedReason,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
    };
  }

  /** Whether `relativePath` changed and has not been applied yet. */
  isPending(relativePath: string): boolean {
    const path = normalizePathSeparators(relativePath);
    if (this.pending.has(path)) return true;
    for (const prefix of this.pendingPrefixes) {
      if (path.startsWith(prefix + "/")) return true;
    }
    return this.needsFullScan !== null;
  }

  /** Resolves once no flush is running; a test seam and used by the daemon's stop. */
  async settle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  /** Handle one raw event; public so tests can drive it without an OS watcher. */
  onEvent(_event: WatchEventType, filename: string | null): void {
    if (this.stopped) return;
    if (filename === null) {
      // The platform could not say which path changed.
      this.requestFullScan("event without a path");
      return;
    }
    const path = normalizePathSeparators(filename);
    if (!path || isHiddenRelativePath(path) || this.ignored(path)) return;
    if (path.split("/").some(segment => REINDEX_EXCLUDED_DIRS.includes(segment))) return;

    let isDirectory = false;
    let exists = true;
    try {
      isDirectory = statSync(join(this.collection.path, path)).isDirectory();
    } catch (err) {
      if (errnoCode(err) !== "ENOENT" && errnoCode(err) !== "ENOTDIR") return;
      exists = false;
    }

    if (exists && isDirectory) {
      // A directory appeared or was renamed into place: its files emitted no
      // events of their own, so only a scan finds them.
      if (this.dirWatchers.size > 0) this.watchDirectoryTree(join(this.collection.path, path));
      this.requestFullScan(`directory event ${path}`);
      return;
    }
    if (this.matches(path)) {
      this.pending.set(path, Date.now());
    } else if (!exists) {
      // Gone and not a file of this collection: most likely a directory that
      // held some. The indexer retires every document under the prefix.
      this.pendingPrefixes.add(path);
    } else {
      return;
    }
    if (this.pending.size > FULL_SCAN_ABOVE_PENDING) this.requestFullScan(`${this.pending.size} files pending`);
    this.schedule();
  }

  private requestFullScan(reason: string): void {
    if (!this.needsFullScan) this.needsFullScan = reason;
    this.schedule();
  }

  private schedule(delayMs?: number): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const quiet = delayMs ?? (this.pending.size <= QUICK_SYNC_MAX_PENDING && !this.needsFullScan ? this.quickMs : this.debounceMs);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, quiet);
    this.debounceTimer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      // A flush is running; its completion reschedules for what arrived meanwhile.
      return;
    }
    if (this.pending.size === 0 && this.pendingPrefixes.size === 0 && !this.needsFullScan) return;
    this.flushStartedMs = Date.now();
    let failed = false;
    const full = this.needsFullScan;
    const paths = [...this.pending.keys()];
    const prefixes = [...this.pendingPrefixes];
    const flush: WatchFlush = full ? { kind: "full", reason: full } : { kind: "files", paths, prefixes };
    this.flushing = (async () => {
      try {
        await this.onFlush(flush);
        this.consecutiveFailures = 0;
        this.lastError = null;
        this.lastFlushAt = Date.now();
        // Keep entries that changed again while the flush ran.
        for (const [path, seenAt] of this.pending) {
          if (seenAt <= this.flushStartedMs) this.pending.delete(path);
        }
        for (const prefix of prefixes) this.pendingPrefixes.delete(prefix);
        if (full && this.needsFullScan === full) this.needsFullScan = null;
      } catch (err) {
        failed = true;
        this.consecutiveFailures++;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.log(`watcher ${this.collection.name}: apply failed (${this.consecutiveFailures}): ${this.lastError}`);
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.degrade(`${this.consecutiveFailures} consecutive indexing failures; last: ${this.lastError}`);
          return;
        }
        this.schedule(Math.min(1000 * 2 ** (this.consecutiveFailures - 1), MAX_RETRY_BACKOFF_MS));
      } finally {
        this.flushing = null;
      }
    })();
    await this.flushing;
    // A failed flush already scheduled its retry with backoff.
    if (!failed && !this.stopped && (this.pending.size > 0 || this.pendingPrefixes.size > 0 || this.needsFullScan)) this.schedule();
  }

  private watchDirectoryTree(root: string): void {
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      if (this.dirWatchers.has(dir)) continue;
      if (this.dirWatchers.size >= MAX_DIR_WATCHES) {
        this.log(`watcher ${this.collection.name}: directory watch cap ${MAX_DIR_WATCHES} reached; deeper changes need qmd update`);
        return;
      }
      const rel = normalizePathSeparators(relative(this.collection.path, dir));
      if (rel && (isHiddenRelativePath(rel) || rel.split("/").some(s => REINDEX_EXCLUDED_DIRS.includes(s)) || this.ignored(rel + "/"))) continue;
      try {
        const watcher = this.watchImpl(dir, { persistent: true }, (event, filename) => {
          const name = filename === null ? null : String(filename);
          this.onEvent(event, name === null ? null : (rel ? `${rel}/${name}` : name));
        });
        watcher.on("error", (err) => this.onWatchError(err));
        this.dirWatchers.set(dir, watcher);
      } catch (err) {
        if (errnoCode(err) === "ENOSPC") {
          this.log(`watcher ${this.collection.name}: inotify watch limit reached; raise fs.inotify.max_user_watches or run qmd update after edits`);
          return;
        }
        throw err;
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
      } catch { /* unreadable directory: skip */ }
      for (const name of entries) stack.push(join(dir, name));
    }
  }

  private onWatchError(err: unknown): void {
    this.degrade(describeWatchError(err));
  }

  private degrade(reason: string): void {
    if (this.degradedReason) return;
    this.degradedReason = reason;
    this.log(`watcher ${this.collection.name}: live watching disabled: ${reason}`);
    this.stop();
  }
}

function describeWatchError(err: unknown): string {
  const code = errnoCode(err);
  if (code === "EMFILE" || code === "ENFILE") return "OS file-descriptor limit reached (EMFILE); run qmd update after edits";
  if (code === "ENOSPC") return "inotify watch limit reached (fs.inotify.max_user_watches); run qmd update after edits";
  return err instanceof Error ? err.message : String(err);
}

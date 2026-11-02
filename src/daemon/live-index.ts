/**
 * The daemon's one writer: every change to the index goes through this
 * class, one task at a time. The watchers feed it the files they saw change,
 * the control channel feeds it `qmd update`, `qmd embed`, `qmd cleanup` and
 * config reloads, and start-up runs a reconcile of every collection so edits
 * made while no daemon ran are caught up.
 *
 * Embedding runs here too, after each apply, for the hashes that have no
 * vectors yet; search keeps answering meanwhile because node-llama-cpp's
 * embed calls yield to the event loop.
 */

import { realpathSync } from "node:fs";
import type { QMDStore, UpdateResult } from "../index.js";
import {
  reindexCollection,
  reindexFiles,
  generateEmbeddings,
  copyVectorsToNewCollections,
  cleanupOrphanedVectors,
  cleanupOrphanedContent,
  getStoreCollections,
  removeCollection,
  syncConfigToDb,
  getActiveDocumentPaths,
  type ReindexResult,
  type EmbedProgress,
  type EmbedResult,
  type ChunkStrategy,
} from "../store.js";
import { loadConfig, type NamedCollection } from "../collections.js";
import type { WatchedCollection, WatchFlush } from "./watcher.js";

export type LiveIndexerOptions = {
  log?: (line: string) => void;
  /** `false` skips embedding entirely; tests and `QMD_DAEMON_EMBED=0` use it. */
  embed?: boolean;
  chunkStrategy?: ChunkStrategy;
  /** Cap on one embedding pass; the rest waits for the next cycle. */
  embedMaxDurationMs?: number;
};

export type ReconcileProgress = {
  collection: string;
  index: number;
  total: number;
  file?: string;
  current?: number;
  fileTotal?: number;
};

export type CollectionReconcile = { name: string; pattern: string; path: string; result: ReindexResult };

export type ReconcileSummary = UpdateResult & { collectionsReindexed: CollectionReconcile[] };

export type LiveIndexerState = {
  busy: string | null;
  lastReconcileAt: number | null;
  lastApplyAt: number | null;
  lastEmbedAt: number | null;
  lastError: string | null;
  queued: number;
};

export class LiveIndexer {
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private readonly log: (line: string) => void;
  private readonly embedEnabled: boolean;
  private readonly chunkStrategy: ChunkStrategy;
  private readonly embedMaxDurationMs: number;
  readonly state: LiveIndexerState = { busy: null, lastReconcileAt: null, lastApplyAt: null, lastEmbedAt: null, lastError: null, queued: 0 };

  constructor(private readonly store: QMDStore, options: LiveIndexerOptions = {}) {
    this.log = options.log ?? (() => {});
    this.embedEnabled = options.embed ?? (process.env.QMD_DAEMON_EMBED !== "0");
    this.chunkStrategy = options.chunkStrategy ?? "auto";
    this.embedMaxDurationMs = options.embedMaxDurationMs ?? 10 * 60 * 1000;
  }

  /** Serialize a write task behind every task queued before it. */
  run<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.queued++;
    this.state.queued = this.queued;
    const next = this.queue.then(async () => {
      this.state.busy = label;
      try {
        return await task();
      } catch (err) {
        this.state.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.state.busy = null;
        this.queued--;
        this.state.queued = this.queued;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** Collections as the store knows them, with roots resolved for watching. */
  collections(): WatchedCollection[] {
    return getStoreCollections(this.store.internal.db).map((col) => this.toWatched(col));
  }

  private toWatched(col: NamedCollection): WatchedCollection {
    let path = col.path;
    try { path = realpathSync(col.path); } catch { /* keep the configured spelling */ }
    return { name: col.name, path, pattern: col.pattern || "**/*.md", ignore: col.ignore };
  }

  /** Full scan of every collection (or the named ones), then embed and clean up. */
  reconcileAll(options: { collections?: string[]; onProgress?: (info: ReconcileProgress) => void } = {}): Promise<ReconcileSummary> {
    return this.run("reconcile", async () => {
      const started = Date.now();
      const all = this.collections();
      const chosen = options.collections ? all.filter((c) => options.collections!.includes(c.name)) : all;
      this.store.internal.clearCache();
      const reindexed: CollectionReconcile[] = [];
      const totals = { indexed: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };
      for (let i = 0; i < chosen.length; i++) {
        const col = chosen[i]!;
        options.onProgress?.({ collection: col.name, index: i + 1, total: chosen.length });
        const result = await reindexCollection(this.store.internal, col.path, col.pattern, col.name, {
          ignorePatterns: col.ignore,
          onProgress: (info) => options.onProgress?.({ collection: col.name, index: i + 1, total: chosen.length, file: info.file, current: info.current, fileTotal: info.total }),
        });
        reindexed.push({ name: col.name, pattern: col.pattern, path: col.path, result });
        totals.indexed += result.indexed;
        totals.updated += result.updated;
        totals.unchanged += result.unchanged;
        totals.removed += result.removed;
        totals.skipped += result.skipped;
      }
      const cleanup = this.cleanupVectors();
      this.state.lastReconcileAt = Date.now();
      this.log(`reconcile: ${chosen.length} collection(s), ${totals.indexed} new, ${totals.updated} updated, ${totals.unchanged} unchanged, ${totals.removed} removed in ${Date.now() - started} ms`);
      return {
        collections: chosen.length,
        ...totals,
        staleVectorsRemoved: cleanup.staleVectorsRemoved,
        vectorsCopied: cleanup.vectorsCopied,
        needsEmbedding: this.store.internal.getHashesNeedingEmbedding(),
        collectionsReindexed: reindexed,
      };
    }).then(async (summary) => {
      await this.embedPending();
      return summary;
    });
  }

  /** Apply one watcher flush for `collection`. */
  async applyFlush(collection: WatchedCollection, flush: WatchFlush): Promise<ReindexResult> {
    if (flush.kind === "full") {
      this.log(`apply ${collection.name}: full scan (${flush.reason})`);
      const result = await this.run(`scan ${collection.name}`, async () => {
        const r = await reindexCollection(this.store.internal, collection.path, collection.pattern, collection.name, { ignorePatterns: collection.ignore });
        this.cleanupVectors();
        this.state.lastApplyAt = Date.now();
        return r;
      });
      await this.embedPending(collection.name);
      return result;
    }
    const result = await this.run(`apply ${collection.name}`, async () => {
      const started = Date.now();
      const db = this.store.internal.db;
      const paths = new Set(flush.paths);
      // A vanished prefix retires every document that lived under it.
      if (flush.prefixes.length > 0) {
        for (const active of getActiveDocumentPaths(db, collection.name)) {
          if (flush.prefixes.some((prefix) => active.startsWith(prefix + "/"))) paths.add(active);
        }
      }
      const r = await reindexFiles(this.store.internal, collection.path, collection.name, [...paths]);
      const cleanup = r.updated > 0 || r.removed > 0 ? this.cleanupVectors() : null;
      this.state.lastApplyAt = Date.now();
      this.log(`apply ${collection.name}: ${paths.size} path(s): ${r.indexed} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.removed} removed${cleanup ? `, ${cleanup.staleVectorsRemoved} stale vector row(s)` : ""} in ${Date.now() - started} ms`);
      return r;
    });
    if (result.indexed > 0 || result.updated > 0) await this.embedPending(collection.name);
    return result;
  }

  /** Embed every hash that lacks vectors, optionally within one collection. */
  embedPending(collection?: string, onProgress?: (info: EmbedProgress) => void): Promise<EmbedResult | null> {
    if (!this.embedEnabled) return Promise.resolve(null);
    return this.run(`embed${collection ? ` ${collection}` : ""}`, async () => {
      if (this.store.internal.getHashesNeedingEmbedding() === 0) return null;
      const started = Date.now();
      const result = await generateEmbeddings(this.store.internal, {
        collection,
        chunkStrategy: this.chunkStrategy,
        maxDurationMs: this.embedMaxDurationMs,
        onProgress,
      });
      this.state.lastEmbedAt = Date.now();
      this.log(`embed${collection ? ` ${collection}` : ""}: ${result.chunksEmbedded} chunk(s) from ${result.docsProcessed} document(s), ${result.errors} error(s) in ${Date.now() - started} ms`);
      return result;
    });
  }

  /** Copy vectors into collections that gained an embedded hash, then drop orphaned vectors and content. */
  private cleanupVectors(): { staleVectorsRemoved: number; vectorsCopied: number; orphanedContent: number } {
    const db = this.store.internal.db;
    const vectorsCopied = copyVectorsToNewCollections(db).copied;
    const staleVectorsRemoved = cleanupOrphanedVectors(db);
    const orphanedContent = cleanupOrphanedContent(db);
    return { staleVectorsRemoved, vectorsCopied, orphanedContent };
  }

  /**
   * Re-read the YAML config and bring the store's collections in line: new or
   * changed collections are scanned, removed ones lose their documents and
   * vectors. Returns the names that changed so the daemon can restart watchers.
   */
  reloadConfig(onProgress?: (info: ReconcileProgress) => void): Promise<{ added: string[]; removed: string[]; changed: string[]; removedDocuments: Record<string, number>; summary: ReconcileSummary | null }> {
    return this.run("reload", async () => {
      const db = this.store.internal.db;
      const before = new Map(getStoreCollections(db).map((c) => [c.name, c]));
      const config = loadConfig();
      syncConfigToDb(db, config);
      const after = new Map(getStoreCollections(db).map((c) => [c.name, c]));
      const added = [...after.keys()].filter((n) => !before.has(n));
      const removed = [...before.keys()].filter((n) => !after.has(n));
      const changed = [...after.keys()].filter((n) => {
        const a = before.get(n);
        const b = after.get(n)!;
        return a !== undefined && (a.path !== b.path || (a.pattern ?? "") !== (b.pattern ?? "") || JSON.stringify(a.ignore ?? []) !== JSON.stringify(b.ignore ?? []));
      });
      // Scan additions first: a renamed collection's documents are re-created
      // under the new name while the old partition still holds their vectors,
      // so the copy finds them before the removal below deletes the partition.
      let summary: ReconcileSummary | null = null;
      const toScan = [...added, ...changed];
      if (toScan.length > 0) {
        summary = await this.reconcileCollectionsLocked(toScan, onProgress);
      }
      const removedDocuments: Record<string, number> = {};
      for (const name of removed) {
        const r = removeCollection(db, name);
        removedDocuments[name] = r.deletedDocs;
        this.log(`reload: removed collection ${name} (${r.deletedDocs} documents)`);
      }
      if (removed.length > 0) this.cleanupVectors();
      this.log(`reload: ${added.length} added, ${changed.length} changed, ${removed.length} removed`);
      return { added, removed, changed, removedDocuments, summary };
    }).then(async (outcome) => {
      if (outcome.added.length > 0 || outcome.changed.length > 0) await this.embedPending();
      return outcome;
    });
  }

  /** `reconcileAll` for callers already inside the queue. */
  private async reconcileCollectionsLocked(names: string[], onProgress?: (info: ReconcileProgress) => void): Promise<ReconcileSummary> {
    const chosen = this.collections().filter((c) => names.includes(c.name));
    const reindexed: CollectionReconcile[] = [];
    const totals = { indexed: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };
    for (let i = 0; i < chosen.length; i++) {
      const col = chosen[i]!;
      onProgress?.({ collection: col.name, index: i + 1, total: chosen.length });
      const result = await reindexCollection(this.store.internal, col.path, col.pattern, col.name, { ignorePatterns: col.ignore });
      reindexed.push({ name: col.name, pattern: col.pattern, path: col.path, result });
      totals.indexed += result.indexed;
      totals.updated += result.updated;
      totals.unchanged += result.unchanged;
      totals.removed += result.removed;
      totals.skipped += result.skipped;
    }
    const cleanup = this.cleanupVectors();
    this.state.lastReconcileAt = Date.now();
    return {
      collections: chosen.length,
      ...totals,
      staleVectorsRemoved: cleanup.staleVectorsRemoved,
      vectorsCopied: cleanup.vectorsCopied,
      needsEmbedding: this.store.internal.getHashesNeedingEmbedding(),
      collectionsReindexed: reindexed,
    };
  }
}

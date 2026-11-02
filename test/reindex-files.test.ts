/**
 * `reindexFiles`: the targeted re-index the live indexer runs for the paths a
 * watcher reported, sharing its per-file body with the full scan.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, reindexCollection, reindexFiles, getActiveDocumentPaths, type Store } from "../src/store.ts";

let dir: string;
let root: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-reindex-files-"));
  root = join(dir, "docs");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "a.md"), "# A\n\nalpha text\n");
  await writeFile(join(root, "sub", "b.md"), "# B\n\nbeta text\n");
  store = createStore(join(dir, "index.sqlite"));
  await reindexCollection(store, root, "**/*.md", "docs");
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const active = () => getActiveDocumentPaths(store.db, "docs").sort();
const body = (path: string) => store.db.prepare(`SELECT c.doc AS doc FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = 'docs' AND d.path = ? AND d.active = 1`).get(path) as { doc: string } | undefined;

describe("reindexFiles", () => {
  test("indexes a new file and updates a changed one", async () => {
    await writeFile(join(root, "c.md"), "# C\n\ngamma text\n");
    await writeFile(join(root, "a.md"), "# A\n\nalpha changed\n");
    const result = await reindexFiles(store, root, "docs", ["c.md", "a.md"]);
    expect(result).toMatchObject({ indexed: 1, updated: 1, unchanged: 0, removed: 0, skipped: 0 });
    expect(active()).toEqual(["a.md", "c.md", "sub/b.md"]);
    expect(body("a.md")?.doc).toContain("alpha changed");
  });

  test("an unchanged file counts as unchanged without a rewrite", async () => {
    const result = await reindexFiles(store, root, "docs", ["sub/b.md"]);
    expect(result).toMatchObject({ indexed: 0, updated: 0, unchanged: 1, removed: 0 });
  });

  test("a deleted file deactivates its document and drops its sync row", async () => {
    await unlink(join(root, "sub", "b.md"));
    const result = await reindexFiles(store, root, "docs", ["sub/b.md"]);
    expect(result).toMatchObject({ removed: 1, indexed: 0, updated: 0 });
    expect(active()).toEqual(["a.md"]);
    const sync = store.db.prepare(`SELECT COUNT(*) AS n FROM file_sync_state WHERE collection = 'docs' AND relative_path = 'sub/b.md'`).get() as { n: number };
    expect(sync.n).toBe(0);
  });

  test("a rename is a removal of the old path and an index of the new one", async () => {
    await rename(join(root, "a.md"), join(root, "renamed.md"));
    const result = await reindexFiles(store, root, "docs", ["a.md", "renamed.md"]);
    expect(result).toMatchObject({ removed: 1, indexed: 1 });
    expect(active()).toEqual(["renamed.md", "sub/b.md"]);
  });

  test("an emptied file is retired; a path that never existed is a no-op", async () => {
    await writeFile(join(root, "a.md"), "   \n");
    const result = await reindexFiles(store, root, "docs", ["a.md", "never.md"]);
    expect(result.removed).toBe(1);
    expect(result.indexed).toBe(0);
    expect(active()).toEqual(["sub/b.md"]);
  });

  test("a path that became a directory retires the document", async () => {
    await unlink(join(root, "a.md"));
    await mkdir(join(root, "a.md"));
    const result = await reindexFiles(store, root, "docs", ["a.md"]);
    expect(result.removed).toBe(1);
    expect(active()).toEqual(["sub/b.md"]);
  });

  test("hidden paths and parent-relative paths are ignored, duplicates folded", async () => {
    await writeFile(join(dir, "outside.md"), "# Out\n\noutside\n");
    await writeFile(join(root, ".hidden.md"), "# H\n\nhidden\n");
    // A `..` segment is dot-prefixed, so it is dropped with the hidden paths
    // before any stat; nothing outside the root is ever read.
    const result = await reindexFiles(store, root, "docs", ["../outside.md", ".hidden.md", "a.md", "a.md"]);
    expect(result.skippedFiles).toEqual([]);
    expect(result.unchanged).toBe(1);
    expect(result.indexed).toBe(0);
    expect(active()).toEqual(["a.md", "sub/b.md"]);
  });

  test("the full scan and the targeted scan agree afterwards", async () => {
    await writeFile(join(root, "c.md"), "# C\n\ngamma\n");
    await unlink(join(root, "a.md"));
    await reindexFiles(store, root, "docs", ["c.md", "a.md"]);
    const full = await reindexCollection(store, root, "**/*.md", "docs");
    expect(full).toMatchObject({ indexed: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(active()).toEqual(["c.md", "sub/b.md"]);
  });
});

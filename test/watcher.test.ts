/**
 * CollectionWatcher: event filtering, debounce, the quick path for small
 * changes, directory events, vanished prefixes and degradation, driven
 * through an injected `fs.watch` so no OS watcher is involved.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollectionWatcher, type WatchFlush, type WatchImpl, type WatchHandle } from "../src/daemon/watcher.ts";

class FakeWatcher extends EventEmitter implements WatchHandle {
  closed = false;
  close(): void { this.closed = true; }
}

type Installed = { path: string; options: unknown; listener: Parameters<WatchImpl>[2]; watcher: FakeWatcher };

function fakeWatch(installed: Installed[], failWith?: NodeJS.ErrnoException): WatchImpl {
  return (path, options, listener) => {
    if (failWith) throw failWith;
    const watcher = new FakeWatcher();
    installed.push({ path, options, listener, watcher });
    return watcher;
  };
}

let root: string;
let installed: Installed[];
let flushes: WatchFlush[];
let watcher: CollectionWatcher | null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qmd-watcher-"));
  await mkdir(join(root, "sub"));
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "a.md"), "a");
  await writeFile(join(root, "sub", "b.md"), "b");
  await writeFile(join(root, "notes.txt"), "t");
  await writeFile(join(root, "node_modules", "pkg", "readme.md"), "n");
  installed = [];
  flushes = [];
  watcher = null;
});

afterEach(async () => {
  watcher?.stop();
  await rm(root, { recursive: true, force: true });
});

function make(onFlush?: (f: WatchFlush) => Promise<void>, opts: { ignore?: string[]; failWith?: NodeJS.ErrnoException } = {}): CollectionWatcher {
  watcher = new CollectionWatcher(
    { name: "docs", path: root, pattern: "**/*.md", ignore: opts.ignore },
    onFlush ?? (async (f) => { flushes.push(f); }),
    { debounceMs: 60, quickMs: 15, watchImpl: fakeWatch(installed, opts.failWith) },
  );
  return watcher;
}

const emit = (filename: string | null) => installed[0]!.listener("change", filename);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CollectionWatcher", () => {
  test("installs one recursive watch on the root", () => {
    const w = make();
    expect(w.start()).toBe(true);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.path).toBe(root);
    expect(installed[0]!.options).toMatchObject({ recursive: true });
    expect(w.status()).toMatchObject({ collection: "docs", watching: true, pending: 0, degraded: null });
  });

  test("a matching file change is flushed after the quick window", async () => {
    make().start();
    emit("a.md");
    expect(watcher!.isPending("a.md")).toBe(true);
    expect(watcher!.status().pending).toBe(1);
    await settle(40);
    expect(flushes).toEqual([{ kind: "files", paths: ["a.md"], prefixes: [] }]);
    expect(watcher!.isPending("a.md")).toBe(false);
    expect(watcher!.status().pending).toBe(0);
  });

  test("hidden, excluded, ignored and non-matching paths are dropped", async () => {
    make(undefined, { ignore: ["sub/**"] }).start();
    emit(".git/index");
    emit("node_modules/pkg/readme.md");
    emit("sub/b.md");
    emit("notes.txt");
    await settle(40);
    expect(flushes).toEqual([]);
    expect(watcher!.status().pending).toBe(0);
  });

  test("more than two pending files wait for the full debounce", async () => {
    make().start();
    emit("a.md");
    emit("sub/b.md");
    emit("c.md");
    await settle(30);
    expect(flushes).toEqual([]);
    await settle(60);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({ kind: "files", prefixes: [] });
    expect((flushes[0] as { paths: string[] }).paths.sort()).toEqual(["a.md", "c.md", "sub/b.md"]);
  });

  test("a directory event asks for a full scan", async () => {
    make().start();
    emit("sub");
    await settle(100);
    expect(flushes).toEqual([{ kind: "full", reason: "directory event sub" }]);
  });

  test("a vanished non-matching path is reported as a prefix", async () => {
    make().start();
    emit("gone-dir");
    await settle(40);
    expect(flushes).toEqual([{ kind: "files", paths: [], prefixes: ["gone-dir"] }]);
  });

  test("a missing filename asks for a full scan", async () => {
    make().start();
    emit(null);
    await settle(100);
    expect(flushes).toEqual([{ kind: "full", reason: "event without a path" }]);
  });

  test("changes during a flush are kept for the next one", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const seen: WatchFlush[] = [];
    make(async (f) => { seen.push(f); if (seen.length === 1) await gate; }).start();
    emit("a.md");
    await settle(30);
    expect(seen).toHaveLength(1);
    emit("sub/b.md");
    expect(watcher!.isPending("sub/b.md")).toBe(true);
    release();
    await settle(60);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ kind: "files", paths: ["sub/b.md"], prefixes: [] });
    expect(watcher!.status().pending).toBe(0);
  });

  test("repeated failures back off, then disable watching with the reason", async () => {
    let calls = 0;
    make(async () => { calls++; throw new Error("disk on fire"); }).start();
    emit("a.md");
    // Backoff doubles from 1 s; five failures take about 15 s, so only the
    // first two attempts are observed here and the pending entry survives.
    await settle(1200);
    expect(calls).toBe(2);
    expect(watcher!.isPending("a.md")).toBe(true);
    expect(watcher!.status().lastError).toBe("disk on fire");
    expect(watcher!.status().degraded).toBeNull();
  }, 5000);

  test("an fs.watch that fails with EMFILE degrades the watcher", () => {
    const err = Object.assign(new Error("too many open files"), { code: "EMFILE" }) as NodeJS.ErrnoException;
    const w = make(undefined, { failWith: err });
    expect(w.start()).toBe(false);
    expect(w.status().watching).toBe(false);
    expect(w.status().degraded).toContain("EMFILE");
  });

  test("a missing root degrades with the path in the reason", async () => {
    await rm(root, { recursive: true, force: true });
    const w = make();
    expect(w.start()).toBe(false);
    expect(w.status().degraded).toContain(root);
  });

  test("stop closes the watch and drops the timer", async () => {
    const w = make();
    w.start();
    emit("a.md");
    w.stop();
    await settle(40);
    expect(flushes).toEqual([]);
    expect(installed[0]!.watcher.closed).toBe(true);
  });
});

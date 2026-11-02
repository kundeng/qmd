/**
 * Writer lock tests: one writer per index (generalizes the #825 embed lock).
 */
import { describe, test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  writerLockPathForDb,
  tryAcquireWriterLock,
  readWriterLock,
  isLiveWriterLockHolder,
  writerLockHeldMessage,
  EMBED_LOCK_BUSY_MESSAGE,
} from "../src/daemon/writer-lock.ts";
import { tryAcquirePidLock, clearStalePidLock, decodePidLock, isProcessAlive } from "../src/daemon/lock.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function withTempDb(prefix: string, fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(join(dir, "index.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Spawn the holder helper with a `qmd` argv token so isQmdMcpPid(child) is true. */
function spawnHolder(dbPath: string, mode: string, holdMs: number) {
  const holderTs = join(thisDir, "_helpers", "writer-lock-holder.ts");
  const args = isBunRuntime
    ? [holderTs, dbPath, mode, String(holdMs), "qmd", mode]
    : [tsxCli, holderTs, dbPath, mode, String(holdMs), "qmd", mode];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const held = new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (stdout.includes("HOLD")) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > 8000) {
        clearInterval(timer);
        reject(new Error(`child never acquired lock: stdout=${stdout} stderr=${stderr}`));
      }
    }, 20);
  });
  // The race test never awaits `held`; keep its rejection from surfacing as an unhandled one.
  held.catch(() => {});
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { child, held, exited, output: () => ({ stdout, stderr }) };
}

describe("writerLockPathForDb", () => {
  test("places .qmd-writer.lock next to the index database", () => {
    expect(writerLockPathForDb("/tmp/qmd-cache/index.sqlite")).toBe("/tmp/qmd-cache/.qmd-writer.lock");
    expect(writerLockPathForDb("/var/lib/qmd/custom.sqlite")).toBe("/var/lib/qmd/.qmd-writer.lock");
  });
});

describe("isLiveWriterLockHolder", () => {
  test("treats the current process as a live holder", () => {
    expect(isLiveWriterLockHolder(process.pid)).toBe(true);
  });

  test("rejects invalid and dead PIDs", () => {
    expect(isLiveWriterLockHolder(0)).toBe(false);
    expect(isLiveWriterLockHolder(-1)).toBe(false);
    expect(isLiveWriterLockHolder(999999999)).toBe(false);
  });
});

describe("pid lock primitives", () => {
  test("acquire writes a complete JSON record; second acquire reads it back", async () => {
    await withTempDb("qmd-pidlock-", async (dbPath) => {
      const pidPath = join(dirname(dbPath), "x.lock");
      const first = tryAcquirePidLock(pidPath, { pid: process.pid, mode: "test", startedAt: 42 });
      expect(first.kind).toBe("acquired");
      const second = tryAcquirePidLock(pidPath, { pid: process.pid, mode: "other", startedAt: 43 });
      expect(second.kind).toBe("taken");
      if (second.kind === "taken") {
        expect(second.existing).toEqual({ pid: process.pid, mode: "test", startedAt: 42 });
        expect(second.raw).toBe(readFileSync(pidPath, "utf-8"));
      }
    });
  });

  test("clearStalePidLock is compare-and-delete", async () => {
    await withTempDb("qmd-pidlock-cad-", async (dbPath) => {
      const pidPath = join(dirname(dbPath), "x.lock");
      writeFileSync(pidPath, "123\n");
      expect(clearStalePidLock(pidPath, "456\n")).toBe(false);
      expect(existsSync(pidPath)).toBe(true);
      expect(clearStalePidLock(pidPath, "123\n")).toBe(true);
      expect(existsSync(pidPath)).toBe(false);
      expect(clearStalePidLock(pidPath, null)).toBe(true);
    });
  });

  test("decodePidLock accepts the legacy plain-pid form and rejects garbage", () => {
    expect(decodePidLock("4242\n")).toEqual({ pid: 4242, mode: "unknown", startedAt: 0 });
    expect(decodePidLock("")).toBeNull();
    expect(decodePidLock("not a lock")).toBeNull();
    expect(decodePidLock('{"pid":"7","mode":"x"}')).toBeNull();
    expect(decodePidLock('{"pid":7,"mode":"daemon","startedAt":5,"socketPath":"/s"}')).toMatchObject({ pid: 7, mode: "daemon", startedAt: 5, socketPath: "/s" });
  });

  test("isProcessAlive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999999999)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });
});

describe("tryAcquireWriterLock", () => {
  test("lock held → second acquire reports the holder; release → acquire proceeds", async () => {
    await withTempDb("qmd-writer-lock-", async (dbPath) => {
      const lockPath = writerLockPathForDb(dbPath);
      const first = tryAcquireWriterLock(dbPath, "update");
      expect(first.kind).toBe("acquired");
      expect(existsSync(lockPath)).toBe(true);
      expect(readWriterLock(dbPath)).toMatchObject({ pid: process.pid, mode: "update" });

      const second = tryAcquireWriterLock(dbPath, "embed");
      expect(second.kind).toBe("taken");
      if (second.kind === "taken") {
        expect(second.lockPath).toBe(lockPath);
        expect(second.holder).toMatchObject({ pid: process.pid, mode: "update" });
      }

      if (first.kind === "acquired") first.release();
      expect(existsSync(lockPath)).toBe(false);
      expect(readWriterLock(dbPath)).toBeNull();

      const again = tryAcquireWriterLock(dbPath, "embed");
      expect(again.kind).toBe("acquired");
      if (again.kind === "acquired") again.release();
    });
  });

  test("cross-process: live qmd-like holder blocks; release allows proceed", async () => {
    await withTempDb("qmd-writer-lock-xp-", async (dbPath) => {
      const holder = spawnHolder(dbPath, "update", 1000);
      await holder.held;

      const blocked = tryAcquireWriterLock(dbPath, "embed");
      expect(blocked.kind).toBe("taken");
      if (blocked.kind === "taken") {
        expect(blocked.holder?.mode).toBe("update");
        // Under tsx the helper runs in a grandchild, so the pid is checked for liveness, not equality.
        expect(isProcessAlive(blocked.holder?.pid ?? 0)).toBe(true);
      }

      const exitCode = await holder.exited;
      const { stdout, stderr } = holder.output();
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("RELEASED");

      const after = tryAcquireWriterLock(dbPath, "embed");
      expect(after.kind).toBe("acquired");
      if (after.kind === "acquired") after.release();
    });
  }, 20_000);

  test("two processes racing: exactly one acquires", async () => {
    await withTempDb("qmd-writer-lock-race-", async (dbPath) => {
      const a = spawnHolder(dbPath, "update", 700);
      const b = spawnHolder(dbPath, "update", 700);
      const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
      const codes = [codeA, codeB].sort();
      // One holds and exits 0; the other finds a live qmd holder and exits 2.
      expect(codes).toEqual([0, 2]);
      expect(existsSync(writerLockPathForDb(dbPath))).toBe(false);
    });
  }, 20_000);

  test("replaces a stale lock from a dead PID and proceeds", async () => {
    await withTempDb("qmd-writer-lock-stale-", async (dbPath) => {
      const lockPath = writerLockPathForDb(dbPath);
      writeFileSync(lockPath, JSON.stringify({ pid: 999999999, mode: "update", startedAt: 1 }) + "\n");
      const handle = tryAcquireWriterLock(dbPath, "embed");
      expect(handle.kind).toBe("acquired");
      expect(JSON.parse(await readFile(lockPath, "utf-8")).pid).toBe(process.pid);
      if (handle.kind === "acquired") handle.release();
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test("replaces a legacy plain-pid lock from a dead PID", async () => {
    await withTempDb("qmd-writer-lock-legacy-", async (dbPath) => {
      const lockPath = writerLockPathForDb(dbPath);
      writeFileSync(lockPath, "999999999\n");
      const handle = tryAcquireWriterLock(dbPath, "update");
      expect(handle.kind).toBe("acquired");
      if (handle.kind === "acquired") handle.release();
    });
  });

  test("release is idempotent and only unlinks an owned lock", async () => {
    await withTempDb("qmd-writer-lock-own-", async (dbPath) => {
      const lockPath = writerLockPathForDb(dbPath);
      const handle = tryAcquireWriterLock(dbPath, "cleanup");
      expect(handle.kind).toBe("acquired");
      if (handle.kind !== "acquired") return;
      handle.release();
      handle.release();
      expect(existsSync(lockPath)).toBe(false);

      const again = tryAcquireWriterLock(dbPath, "cleanup");
      expect(again.kind).toBe("acquired");
      writeFileSync(lockPath, JSON.stringify({ pid: 1, mode: "daemon", startedAt: 0 }) + "\n");
      if (again.kind === "acquired") again.release();
      expect(existsSync(lockPath)).toBe(true);
      unlinkSync(lockPath);
    });
  });
});

describe("messages", () => {
  test("EMBED_LOCK_BUSY_MESSAGE matches the #825 skip message", () => {
    expect(EMBED_LOCK_BUSY_MESSAGE).toBe("Another embed process is already running. Skipping.");
  });

  test("writerLockHeldMessage names the holder, its mode and the lock path", () => {
    const msg = writerLockHeldMessage({ pid: 4321, mode: "update", startedAt: 0 }, "/x/.qmd-writer.lock");
    expect(msg).toContain("qmd update (PID 4321)");
    expect(msg).toContain("/x/.qmd-writer.lock");
    expect(writerLockHeldMessage(null, "/x/.qmd-writer.lock")).toContain("another qmd process");
  });
});

/**
 * End to end: the daemon keeps the index current from file events, flags
 * results whose files are still being indexed, and takes `qmd update`,
 * `qmd collection add` and `qmd cleanup` on the CLI's behalf while it holds
 * the writer lock. Embedding is off (`QMD_DAEMON_EMBED=0`) so no model is
 * needed; keyword search is what is checked.
 */
import { describe, test, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "../src/daemon/lock.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(thisDir, "..");
const cliPath = join(repoRoot, "src", "cli", "qmd.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const runtimeArgs = (args: string[]) => (isBunRuntime ? [cliPath, ...args] : [tsxCli, cliPath, ...args]);

type Env = Record<string, string>;
type JsonRpc = { jsonrpc: "2.0"; id?: number; method: string; params?: Record<string, unknown> };
type ToolReply = { result?: { content?: { text?: string }[]; structuredContent?: { results?: { file: string; stale?: true }[]; pendingFiles?: number } } };

async function makeEnv(): Promise<{ work: string; docs: string; env: Env; runDir: string }> {
  const work = await mkdtemp(join(tmpdir(), "qmd-live-e2e-"));
  const docs = join(work, "docs");
  await mkdir(docs);
  await writeFile(join(docs, "a.md"), "# Alpha\n\nThe quick brown fox.\n");
  await writeFile(join(docs, "b.md"), "# Beta\n\nLorem ipsum dolor.\n");
  await writeFile(join(work, "index.yml"), `collections:\n  docs:\n    path: ${docs}\n    pattern: "**/*.md"\n`);
  const env: Env = {
    ...(process.env as Env),
    INDEX_PATH: join(work, "index.sqlite"),
    QMD_CONFIG_DIR: work,
    XDG_CACHE_HOME: join(work, "cache"),
    QMD_DAEMON_IDLE_MS: "60000",
    QMD_DAEMON_EMBED: "0",
    QMD_WATCH_DEBOUNCE_MS: "300",
    QMD_DOCTOR_DEVICE_PROBE: "0",
  };
  return { work, docs, env, runDir: join(work, "cache", "qmd", "run") };
}

class McpClient {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  private out = "";
  private nextId = 1;

  constructor(env: Env) {
    this.child = spawn(process.execPath, runtimeArgs(["mcp"]), { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.on("close", (code) => resolve(code)));
    this.child.stdout!.on("data", (d: Buffer) => { this.out += d.toString(); });
    this.child.stderr!.on("data", () => {});
  }

  send(msg: JsonRpc): void {
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  call(method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<ToolReply> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        for (const line of this.out.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { id?: number };
            if (msg.id === id) { clearInterval(timer); resolve(msg as ToolReply); return; }
          } catch { /* partial */ }
        }
        if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error(`no reply to ${method} ${id}`)); }
      }, 15);
    });
  }

  async init(): Promise<void> {
    await this.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async lex(query: string): Promise<{ files: string[]; stale: string[]; pending: number; text: string }> {
    const reply = await this.call("tools/call", { name: "query", arguments: { searches: [{ type: "lex", query }], rerank: false, limit: 10 } });
    const results = reply.result?.structuredContent?.results ?? [];
    return {
      files: results.map((r) => r.file),
      stale: results.filter((r) => r.stale).map((r) => r.file),
      pending: reply.result?.structuredContent?.pendingFiles ?? 0,
      text: reply.result?.content?.[0]?.text ?? "",
    };
  }
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (await check()) return Date.now() - start;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function daemonPid(runDir: string): number | null {
  if (!existsSync(runDir)) return null;
  for (const key of readdirSync(runDir)) {
    const pidPath = join(runDir, key, "daemon.pid");
    if (existsSync(pidPath)) return (JSON.parse(readFileSync(pidPath, "utf-8")) as { pid: number }).pid;
  }
  return null;
}

function runCli(env: Env, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, runtimeArgs(args), { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
  return new Promise((resolve) => child.on("close", (code) => resolve({ stdout, stderr, code })));
}

async function teardown(client: McpClient | undefined, runDir: string, work: string): Promise<void> {
  client?.child.kill("SIGKILL");
  const pid = daemonPid(runDir);
  if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await rm(work, { recursive: true, force: true });
}

describe("live indexing through the daemon", () => {
  test("files saved, changed, deleted and added in new directories reach keyword search", async () => {
    const { work, docs, env, runDir } = await makeEnv();
    let client: McpClient | undefined;
    try {
      client = new McpClient(env);
      await client.init();
      // Start-up reconcile indexes the two existing files.
      await until(async () => (await client!.lex("fox")).files.includes("docs/a.md"), "start-up reconcile");

      await writeFile(join(docs, "c.md"), "# Gamma\n\nZebra crossing ahead.\n");
      const addMs = await until(async () => (await client!.lex("zebra")).files.includes("docs/c.md"), "new file");
      expect(addMs).toBeLessThan(10_000);

      await writeFile(join(docs, "a.md"), "# Alpha\n\nThe quick brown giraffe.\n");
      await until(async () => (await client!.lex("giraffe")).files.includes("docs/a.md"), "modified file");
      expect((await client.lex("fox")).files).not.toContain("docs/a.md");

      expect((await client.lex("lorem")).files).toContain("docs/b.md");
      await unlink(join(docs, "b.md"));
      const deleteMs = await until(async () => !(await client!.lex("lorem")).files.includes("docs/b.md"), "deleted file");
      expect(deleteMs).toBeLessThan(10_000);

      await mkdir(join(docs, "sub"));
      await writeFile(join(docs, "sub", "d.md"), "# Delta\n\nQuokka island.\n");
      await until(async () => (await client!.lex("quokka")).files.includes("docs/sub/d.md"), "file in a new directory");

      const status = await client.call("tools/call", { name: "status", arguments: {} });
      expect(status.result?.content?.[0]?.text).toContain("Live indexing: on");
    } finally {
      await teardown(client, runDir, work);
    }
  }, 90_000);

  test("qmd update, collection add and cleanup run through the daemon while it holds the writer lock", async () => {
    const { work, docs, env, runDir } = await makeEnv();
    let client: McpClient | undefined;
    try {
      client = new McpClient(env);
      await client.init();
      await until(async () => (await client!.lex("fox")).files.includes("docs/a.md"), "start-up reconcile");
      const pid = daemonPid(runDir)!;
      expect(existsSync(join(dirname(env.INDEX_PATH), ".qmd-writer.lock"))).toBe(true);

      const update = await runCli(env, ["update"]);
      expect(update.code).toBe(0);
      expect(update.stdout).toContain("through the index daemon");
      expect(update.stdout).toContain("All collections updated");
      expect(update.stdout).toMatch(/Indexed: 0 new, 0 updated, 2 unchanged, 0 removed/);

      const notes = join(work, "notes");
      await mkdir(notes);
      await writeFile(join(notes, "n.md"), "# Note\n\nWalrus tusk.\n");
      const add = await runCli(env, ["collection", "add", notes, "--name", "notes"]);
      expect(add.code).toBe(0);
      expect(add.stdout).toContain("through the index daemon");
      expect(add.stdout).toContain("created successfully");
      expect((await client.lex("walrus")).files).toContain("notes/n.md");
      // The new collection is watched too.
      await writeFile(join(notes, "m.md"), "# More\n\nNarwhal horn.\n");
      await until(async () => (await client!.lex("narwhal")).files.includes("notes/m.md"), "file in the added collection");

      const remove = await runCli(env, ["collection", "remove", "notes"]);
      expect(remove.code).toBe(0);
      expect(remove.stdout).toContain("Deleted 2 documents");
      expect((await client.lex("walrus")).files).toEqual([]);

      const cleanup = await runCli(env, ["cleanup"]);
      expect(cleanup.code).toBe(0);
      expect(cleanup.stdout).toContain("database vacuumed");

      const status = await runCli(env, ["status"]);
      expect(status.stdout).toContain(`Daemon: running (PID ${pid}`);
      expect(status.stdout).toMatch(/1\/1 collection\(s\) watched/);
      expect(isProcessAlive(pid)).toBe(true);
      expect(await client.lex("fox")).toBeTruthy();
      expect(docs).toBeTruthy();
    } finally {
      await teardown(client, runDir, work);
    }
  }, 90_000);
});

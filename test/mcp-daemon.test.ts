/**
 * End-to-end tests for the shared index daemon: `qmd mcp` clients attach to
 * one daemon per index, the daemon exits after its last client, the parent
 * watchdog reaps a proxy whose host died, and `QMD_NO_DAEMON=1` serves
 * in-process. Each test gets its own cache dir, so no daemon touches the
 * user's ~/.cache/qmd/run.
 */
import { describe, test, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function makeEnv(prefix: string, extra: Env = {}): Promise<{ work: string; env: Env; runDir: string }> {
  const work = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(work, "index.yml"), "collections: {}\n");
  const env: Env = {
    ...(process.env as Env),
    INDEX_PATH: join(work, "index.sqlite"),
    QMD_CONFIG_DIR: work,
    XDG_CACHE_HOME: join(work, "cache"),
    QMD_DAEMON_IDLE_MS: "1500",
    QMD_DAEMON_SWEEP_MS: "300",
    QMD_PPID_POLL_MS: "200",
    QMD_DOCTOR_DEVICE_PROBE: "0",
    ...extra,
  };
  return { work, env, runDir: join(work, "cache", "qmd", "run") };
}

type JsonRpcMessage = { jsonrpc: "2.0"; id?: number; method: string; params?: Record<string, unknown> };

type Client = { child: ChildProcess; exited: Promise<number | null>; output: () => string; stderr: () => string; reply: (id: number, timeoutMs?: number) => Promise<Record<string, unknown>> };

function startClient(env: Env, viaShell = false): Client {
  const args = runtimeArgs(["mcp"]);
  const child = viaShell
    // No `exec`: the shell stays the proxy's parent, so killing it orphans the proxy.
    ? spawn("sh", ["-c", `"$0" "$@"`, process.execPath, ...args], { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  // Recorded from spawn time: a proxy may exit while the test awaits something else.
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr!.on("data", (d: Buffer) => { err += d.toString(); });
  const send = (msg: JsonRpcMessage) => child.stdin!.write(JSON.stringify(msg) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const reply = (id: number, timeoutMs = 20_000) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === id) { clearInterval(timer); resolve(msg); return; }
        } catch { /* partial line */ }
      }
      if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error(`no reply ${id}: stdout=${out.slice(0, 500)} stderr=${err.slice(0, 500)}`)); }
    }, 20);
  });
  return { child, exited, output: () => out, stderr: () => err, reply };
}

function toolNames(reply: Record<string, unknown>): string[] {
  const result = reply.result as { tools?: { name: string }[] } | undefined;
  return (result?.tools ?? []).map((t) => t.name).sort();
}

function daemonRecord(runDir: string): { pid: number; dbPath: string } | null {
  if (!existsSync(runDir)) return null;
  for (const key of readdirSync(runDir)) {
    const pidPath = join(runDir, key, "daemon.pid");
    if (existsSync(pidPath)) return JSON.parse(readFileSync(pidPath, "utf-8")) as { pid: number; dbPath: string };
  }
  return null;
}

function daemonLog(runDir: string): string {
  if (!existsSync(runDir)) return "";
  return readdirSync(runDir).map((key) => {
    const p = join(runDir, key, "daemon.log");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }).join("");
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const closed = (child: ChildProcess) => new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

const EXPECTED_TOOLS = ["get", "metadata", "multi_get", "query", "status"];

describe("qmd mcp shared daemon", () => {
  test("two clients share one daemon, which exits after the last one leaves", async () => {
    const { work, env, runDir } = await makeEnv("qmd-daemon-e2e-");
    const children: ChildProcess[] = [];
    try {
      const a = startClient(env);
      children.push(a.child);
      expect(toolNames(await a.reply(2))).toEqual(EXPECTED_TOOLS);
      const record = daemonRecord(runDir);
      expect(record).not.toBeNull();
      expect(record!.dbPath).toBe(env.INDEX_PATH);
      expect(isProcessAlive(record!.pid)).toBe(true);
      expect(record!.pid).not.toBe(a.child.pid);

      const b = startClient(env);
      children.push(b.child);
      expect(toolNames(await b.reply(2))).toEqual(EXPECTED_TOOLS);
      // Still the same daemon.
      expect(daemonRecord(runDir)!.pid).toBe(record!.pid);
      await waitFor(() => daemonLog(runDir).includes("clients=2"), 5000, "two clients in the daemon log");

      a.child.stdin!.end();
      expect(await a.exited).toBe(0);
      await waitFor(() => daemonLog(runDir).includes("clients=1"), 5000, "first client gone");
      expect(isProcessAlive(record!.pid)).toBe(true);

      b.child.stdin!.end();
      expect(await b.exited).toBe(0);
      await waitFor(() => !isProcessAlive(record!.pid), 10_000, "daemon idle exit");
      expect(daemonLog(runDir)).toContain("idle timeout");
      expect(daemonRecord(runDir)).toBeNull();
      expect(existsSync(join(dirname(env.INDEX_PATH), ".qmd-writer.lock"))).toBe(false);
      expect(a.stderr()).toBe("");
      expect(b.stderr()).toBe("");
    } finally {
      for (const child of children) child.kill("SIGKILL");
      const record = daemonRecord(runDir);
      if (record) { try { process.kill(record.pid, "SIGKILL"); } catch { /* gone */ } }
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);

  test("a proxy whose host dies is reaped by the parent watchdog and the daemon drops it", async () => {
    const { work, env, runDir } = await makeEnv("qmd-daemon-ppid-");
    let shell: ChildProcess | undefined;
    try {
      const client = startClient(env, true);
      shell = client.child;
      expect(toolNames(await client.reply(2))).toEqual(EXPECTED_TOOLS);
      const record = daemonRecord(runDir)!;
      await waitFor(() => daemonLog(runDir).includes("clients=1"), 5000, "client registered");
      // Kill the host (the shell); the proxy keeps our stdin pipe open, so only
      // the parent watchdog can notice.
      shell.kill("SIGKILL");
      await waitFor(() => daemonLog(runDir).includes("clients=0"), 10_000, "daemon dropped the client");
      await waitFor(() => !isProcessAlive(record.pid), 10_000, "daemon idle exit");
    } finally {
      shell?.kill("SIGKILL");
      const record = daemonRecord(runDir);
      if (record) { try { process.kill(record.pid, "SIGKILL"); } catch { /* gone */ } }
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);

  test("QMD_NO_DAEMON=1 serves in-process and starts no daemon", async () => {
    const { work, env, runDir } = await makeEnv("qmd-daemon-optout-", { QMD_NO_DAEMON: "1" });
    let child: ChildProcess | undefined;
    try {
      const client = startClient(env);
      child = client.child;
      expect(toolNames(await client.reply(2))).toEqual(EXPECTED_TOOLS);
      expect(existsSync(runDir)).toBe(false);
      client.child.stdin!.end();
      expect(await client.exited).toBe(0);
    } finally {
      child?.kill("SIGKILL");
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);

  test("qmd status reports the daemon and qmd mcp stop ends it", async () => {
    const { work, env, runDir } = await makeEnv("qmd-daemon-stop-", { QMD_DAEMON_IDLE_MS: "60000" });
    let child: ChildProcess | undefined;
    try {
      const client = startClient(env);
      child = client.child;
      expect(toolNames(await client.reply(2))).toEqual(EXPECTED_TOOLS);
      const record = daemonRecord(runDir)!;

      const status = spawn(process.execPath, runtimeArgs(["status"]), { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
      let statusOut = "";
      status.stdout!.on("data", (d: Buffer) => { statusOut += d.toString(); });
      expect(await closed(status)).toBe(0);
      expect(statusOut).toContain(`Daemon: running (PID ${record.pid}`);
      expect(statusOut).toContain(`Writer: daemon (PID ${record.pid})`);

      const stop = spawn(process.execPath, runtimeArgs(["mcp", "stop"]), { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
      let stopOut = "";
      stop.stdout!.on("data", (d: Buffer) => { stopOut += d.toString(); });
      expect(await closed(stop)).toBe(0);
      expect(stopOut).toContain(`Stopped index daemon (PID ${record.pid}).`);
      expect(isProcessAlive(record.pid)).toBe(false);
      // The proxy's socket closed with the daemon, so the proxy exits too.
      expect(await client.exited).toBe(0);
      expect(daemonRecord(runDir)).toBeNull();
    } finally {
      child?.kill("SIGKILL");
      const record = daemonRecord(runDir);
      if (record) { try { process.kill(record.pid, "SIGKILL"); } catch { /* gone */ } }
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);
});

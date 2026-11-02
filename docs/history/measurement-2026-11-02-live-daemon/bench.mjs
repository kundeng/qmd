// Before/after measurement of qmd as a live search engine over inventory-catalog.
// Usage: node bench.mjs <label> <qmd-entry: path to dist/cli/qmd.js or the mise qmd.js> <out-dir> [--live]
// Measures: full index time (update+embed), 3 stdio MCP sessions' RSS and process count,
// idle CPU over 60 s, query latency (lex and full query), and (live mode) save→searchable latency.
import { spawn, spawnSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const [label, entry, outDir, ...flags] = process.argv.slice(2);
const live = flags.includes("--live");
const PROJECT = join(homedir(), "Dropbox/Projects/inventory-catalog");
const work = join(outDir, label);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "cache", "qmd"), { recursive: true });
// Share the already-downloaded models; everything else (index, run dir) is isolated.
symlinkSync(join(homedir(), ".cache/qmd/models"), join(work, "cache", "qmd", "models"));
writeFileSync(join(work, "index.yml"), "collections: {}\n");
const env = { ...process.env, QMD_CONFIG_DIR: work, XDG_CACHE_HOME: join(work, "cache"), INDEX_PATH: join(work, "cache", "qmd", "index.sqlite"), QMD_DOCTOR_DEVICE_PROBE: "0", GGML_METAL_NO_RESIDENCY: "1" };
const log = (line) => { console.log(line); appendFileSync(join(work, "bench.log"), line + "\n"); };
const qmd = (args, opts = {}) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ms: Date.now() - t0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
};
const rssOf = (pid) => { try { return Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) || 0; } catch { return 0; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
log(`# ${label}: entry=${entry} live=${live} at ${new Date().toISOString()} node ${process.version}`);
log(`qmd --version: ${qmd(["--version"]).stdout.trim()}`);

// 1. Index: two collections over inventory-catalog, then embed.
let r = qmd(["collection", "add", join(PROJECT, "docs"), "--name", "inv-docs"]);
log(`collection add inv-docs: ${r.ms} ms (exit ${r.status}) ${r.stdout.split("\n").find((l) => l.startsWith("Indexed")) ?? ""}`);
r = qmd(["collection", "add", PROJECT, "--name", "inv-code", "--mask", "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs}"]);
log(`collection add inv-code: ${r.ms} ms (exit ${r.status}) ${r.stdout.split("\n").find((l) => l.startsWith("Indexed")) ?? ""}`);
r = qmd(["embed"], { timeout: 3_600_000 });
log(`embed: ${r.ms} ms (exit ${r.status}) ${(r.stdout.match(/Embedded .*|All content hashes already have embeddings.*/) ?? [""])[0].replace(/\x1b\[[0-9;]*m/g, "")}`);
log(qmd(["status"]).stdout.split("\n").filter((l) => /Total|Vectors|Pending|Daemon|Index:/.test(l)).join("\n"));

// 2. Three MCP stdio sessions.
class Session {
  constructor() {
    this.child = spawn(process.execPath, [entry, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.out = ""; this.nextId = 1;
    this.child.stdout.on("data", (d) => { this.out += d; });
    this.child.stderr.on("data", () => {});
  }
  send(m) { this.child.stdin.write(JSON.stringify(m) + "\n"); }
  call(method, params, timeoutMs = 120000) {
    const id = this.nextId++; this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { for (const l of this.out.split("\n")) { try { const m = JSON.parse(l); if (m.id === id) { clearInterval(t); res({ msg: m, ms: Date.now() - t0 }); return; } } catch {} } if (Date.now() - t0 > timeoutMs) { clearInterval(t); rej(new Error("timeout " + method)); } }, 5); });
  }
  async init() { await this.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } }); this.send({ jsonrpc: "2.0", method: "notifications/initialized" }); }
  files(reply) { return (reply.msg.result?.structuredContent?.results ?? []).map((x) => x.file); }
}
const sessions = [];
const t0 = Date.now();
for (let i = 0; i < 3; i++) { const s = new Session(); await s.init(); await s.call("tools/list", {}); sessions.push(s); log(`session ${i + 1} ready at +${Date.now() - t0} ms`); }
await sleep(3000);
// Only this run's processes: descendants of the bench, plus any process running
// our entry that did not exist before the run (the detached daemon). The
// machine has other qmd servers from Claude sessions; those are excluded.
const psAll = () => execSync("ps -Ao pid,ppid,rss,pcpu,time,command").toString().trim().split("\n").slice(1).map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], rss: +m[3], pcpu: +m[4], time: m[5], cmd: m[6] }; }).filter(Boolean);
const preexisting = new Set(psAll().filter((p) => p.cmd.includes(entry)).map((p) => p.pid));
const ours = () => { const all = psAll(); const mine = new Set([process.pid]); let grew = true; while (grew) { grew = false; for (const p of all) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.add(p.pid); grew = true; } } return all.filter((p) => p.pid !== process.pid && ((mine.has(p.pid) && /qmd/.test(p.cmd)) || (p.cmd.includes(entry) && !preexisting.has(p.pid)))); };
const procs = () => ours().map((p) => `${p.pid} ${p.ppid} ${p.rss} ${p.pcpu} ${p.cmd}`);
const snapshot = (tag) => { const lines = procs(); const total = lines.reduce((n, l) => n + Number(l.trim().split(/\s+/)[2]), 0); log(`[${tag}] ${lines.length} qmd processes, RSS total ${Math.round(total / 1024)} MB`); for (const l of lines) log("   " + l.trim().replace(/\s+/g, " ").slice(0, 160)); return total; };
snapshot("3 sessions idle");

// 3. Idle CPU over 60 s: sum of CPU seconds consumed by qmd processes.
const cpuSeconds = () => ours().reduce((n, p) => { const parts = p.time.split(":").map(Number); return n + (parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]); }, 0);
const c0 = cpuSeconds(); await sleep(60000); const c1 = cpuSeconds();
log(`idle CPU over 60 s: ${(c1 - c0).toFixed(2)} CPU-seconds across all qmd processes (${(((c1 - c0) / 60) * 100).toFixed(2)}% of one core)`);

// 4. Query latency: lex (BM25, no rerank) and full query (expansion + rerank), 3 runs each, cold then warm.
const s = sessions[0];
for (const q of ["simulation events", "inventory catalog site"]) {
  for (let i = 0; i < 3; i++) { const rep = await s.call("tools/call", { name: "query", arguments: { searches: [{ type: "lex", query: q }], rerank: false, limit: 5 } }); log(`lex "${q}" run ${i + 1}: ${rep.ms} ms, ${s.files(rep).length} results`); }
}
for (const q of ["how are simulated events generated for the catalog"]) {
  for (let i = 0; i < 3; i++) { const rep = await s.call("tools/call", { name: "query", arguments: { query: q, limit: 5 } }); log(`query "${q}" run ${i + 1}: ${rep.ms} ms, ${s.files(rep).length} results${rep.msg.result?.isError ? " ERROR " + rep.msg.result.content?.[0]?.text?.slice(0, 120) : ""}`); }
}
snapshot("after queries (models loaded)");

// 5. Save → searchable. Live: write a file under docs/, poll lex search. Stock: run `qmd update` and time it.
const probe = join(PROJECT, "docs", `bench-probe-${Date.now()}.md`);
const term = `okapibench${Date.now()}`;
try {
  writeFileSync(probe, `# Bench probe\n\n${term} appears here.\n`);
  const tw = Date.now();
  if (live) {
    for (;;) { const rep = await s.call("tools/call", { name: "query", arguments: { searches: [{ type: "lex", query: term }], rerank: false, limit: 5 } }); if (s.files(rep).length > 0) { log(`save → keyword-searchable (live): ${Date.now() - tw} ms`); break; } if (Date.now() - tw > 60000) { log("save → searchable: TIMEOUT 60 s"); break; } await sleep(25); }
    const tv = Date.now();
    for (;;) { const st = qmd(["status"]).stdout; if (!/Pending:\s+[1-9]/.test(st)) { log(`save → embedded (live, status shows no pending): ${Date.now() - tv + (Date.now() - tw - (Date.now() - tv))} ms after save`); break; } if (Date.now() - tv > 180000) { log("save → embedded: TIMEOUT"); break; } await sleep(500); }
  } else {
    const u = qmd(["update"]); log(`stock: file is not searchable until qmd update runs; qmd update took ${u.ms} ms (exit ${u.status})`);
    const e = qmd(["embed"], { timeout: 600000 }); log(`stock: qmd embed for the new file took ${e.ms} ms (exit ${e.status})`);
    const rep = await s.call("tools/call", { name: "query", arguments: { searches: [{ type: "lex", query: term }], rerank: false, limit: 5 } });
    log(`stock: after update, session finds the file: ${s.files(rep).length > 0}`);
  }
} finally {
  if (existsSync(probe)) unlinkSync(probe);
}
await sleep(1500);
snapshot("end");
for (const sess of sessions) sess.child.stdin.end();
await Promise.all(sessions.map((sess) => new Promise((r) => sess.child.on("close", r))));
if (live) { await sleep(2000); log(`after sessions closed: ${procs().length} qmd processes remain (daemon lingers ${env.QMD_DAEMON_IDLE_MS ?? 300000} ms)`); }
log("done");

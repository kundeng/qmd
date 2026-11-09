// Controlled daemon memory measurement on a quiet copy of inventory-catalog.
// Usage: node memory.mjs <label> <extra-env-json> ; prints RSS of the daemon after embed+query and after the 5-minute model unload.
import { spawn, spawnSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const [label, extraJson] = process.argv.slice(2);
const entry = "/Users/kundeng/.local/share/project-git/qmd-worktrees/live/dist/cli/qmd.js";
const PROJECT = join(homedir(), ".local/share/qmd-bench/quiet/inventory-catalog");
const work = join(homedir(), ".local/share/qmd-bench/mem", label);
rmSync(work, { recursive: true, force: true }); mkdirSync(join(work, "cache", "qmd"), { recursive: true });
symlinkSync(join(homedir(), ".cache/qmd/models"), join(work, "cache", "qmd", "models"));
writeFileSync(join(work, "index.yml"), "collections: {}\n");
const env = { ...process.env, QMD_CONFIG_DIR: work, XDG_CACHE_HOME: join(work, "cache"), INDEX_PATH: join(work, "cache/qmd/index.sqlite"), QMD_DOCTOR_DEVICE_PROBE: "0", GGML_METAL_NO_RESIDENCY: "1", QMD_DAEMON_IDLE_MS: "900000", ...JSON.parse(extraJson || "{}") };
const log = (l) => { console.log(l); appendFileSync(join(work, "memory.log"), l + "\n"); };
const qmd = (args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daemonPid = () => { const run = join(work, "cache/qmd/run"); for (const k of readdirSync(run)) { try { return JSON.parse(readFileSync(join(run, k, "daemon.pid"), "utf8")).pid; } catch {} } return null; };
const rss = (pid) => Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString()) / 1024);
log(`# ${label} ${new Date().toISOString()} extra=${extraJson}`);
qmd(["collection", "add", join(PROJECT, "docs"), "--name", "inv-docs"]);
qmd(["collection", "add", PROJECT, "--name", "inv-code", "--mask", "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs}"]);
// Leave embedding to the daemon, so the measurement includes its live-embedding pool.
const client = spawn(process.execPath, [entry, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
let out = ""; client.stdout.on("data", (d) => { out += d; }); client.stderr.on("data", () => {});
let id = 0; const call = (method, params) => { const my = ++id; client.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n"); return new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { for (const l of out.split("\n")) { try { const m = JSON.parse(l); if (m.id === my) { clearInterval(t); res(m); return; } } catch {} } if (Date.now() - t0 > 180000) { clearInterval(t); rej(new Error("timeout")); } }, 20); }); };
await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mem", version: "0" } });
client.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await sleep(2000); const pid = daemonPid(); log(`daemon pid ${pid}, RSS before embedding ${rss(pid)} MB`);
const t0 = Date.now();
for (;;) { const st = qmd(["status"]).stdout; const m = st.match(/Pending:\s+(\d+)/); const vec = st.match(/Vectors:\s+(\d+)/); if (!m && vec && Number(vec[1]) > 0) break; if (Date.now() - t0 > 600000) { log("embedding did not finish in 10 min"); break; } await sleep(2000); }
log(`start-up reconcile + embed done after ${Date.now() - t0} ms; daemon RSS ${rss(pid)} MB; ${(qmd(["status"]).stdout.match(/Vectors:\s+\d+/) || [""])[0]}`);
const q = await call("tools/call", { name: "query", arguments: { query: "how are simulated events generated for the catalog", limit: 5 } });
log(`after full query (${(q.result?.structuredContent?.results ?? []).length} results): daemon RSS ${rss(pid)} MB`);
await call("tools/call", { name: "query", arguments: { query: "site survival origin", limit: 5 } });
log(`after second full query: daemon RSS ${rss(pid)} MB`);
const t1 = Date.now();
for (let i = 1; i <= 6; i++) { await sleep(60000); log(`+${i} min idle: daemon RSS ${rss(pid)} MB`); }
log(`idle wait ${Date.now() - t1} ms`);
client.stdin.end(); await new Promise((r) => client.on("close", r));
await sleep(500); try { process.kill(pid, "SIGTERM"); } catch {}
log("done");

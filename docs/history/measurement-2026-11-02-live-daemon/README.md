# Measurement: stock qmd 2.8.3 versus the live daemon fork (2026-11-02)

Commit measured: `live/main` at 35e1a86 (fork), `@tobilu/qmd` 2.8.3 (facd35e) from the mise global install (stock). Machine: bayes-max, Apple Silicon, macOS 27.0, Node 24.12.0, Metal. Data: `~/Dropbox/Projects/inventory-catalog`, two collections: `inv-docs` over `docs/` (`**/*.md`, 99 files) and `inv-code` over the project (`**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs}`, 188 files). Each run used its own config dir, cache dir and index (`XDG_CACHE_HOME`, `QMD_CONFIG_DIR`, `INDEX_PATH`), sharing only the downloaded models. Both ran the CLI as `node <entry> mcp`, so neither carried the `bin/qmd` launcher process. The three "Claude sessions" are three `qmd mcp` stdio clients driven by the benchmark script.

Rerun: `node bench.mjs <label> <entry> <out-dir> [--live]`, then `python3 summarize.py <stock bench.log> <fork bench.log>`. Raw logs: `bench-stock.log`, `bench-fork.log`, `bench-fork-daemon.log`, `settle.log`. Earlier capture of the machine's real state: `baseline-stock-processes.txt` (28 stock servers from Claude sessions, 3,412 MB RSS).

## Comparison

| Measure | Stock qmd 2.8.3 | Fork (`live/main`) |
|---|---|---|
| qmd version / entry | qmd 2.8.3 (facd35e) | qmd 2.8.3 (35e1a86) |
| Index docs collection (84 md files) | 482 ms | 281 ms |
| Index code collection | 737 ms (Indexed: 188 new, 0 updated, 0 unchanged, 0 removed) | 443 ms (Indexed: 188 new, 0 updated, 0 unchanged, 0 removed) |
| Embed everything (cold) | 89887 ms | 116127 ms |
| Documents / vectors after indexing | 287 / 2176 | 287 / 2176 |
| Three MCP sessions ready (ms after start) | #1 216, #2 380, #3 539 | #1 287, #2 594, #3 791 |
| Processes with three sessions open, idle | 3 | 4 |
| RSS total, three sessions idle | 304 MB | 5426 MB |
| RSS total after queries (models loaded) | 6281 MB (3 proc.) | 10324 MB (4 proc.) |
| Idle CPU, 60 s, all qmd processes | 0.00 s (0.00% of a core) | 10.98 s (18.30% of a core) |
| BM25 query latency, first / best of next (ms) | 41 / 24 | 17 / 10 |
| Full query (expand + rerank), first / best of next (ms) | 29008 / 397 | 16756 / 85 |
| Save → keyword-searchable | never until `qmd update`; update took 485 ms, embed 28415 ms | 449 ms |
| Save → embedded | after a manual `qmd embed` | 640 ms after save |
| After all sessions close | every server exits with its host | 0 qmd processes remain (daemon lingers 300000 ms) |

Query runs (ms):
- stock lex: "simulation events" #1 41 ms (5 res), "simulation events" #2 29 ms (5 res), "simulation events" #3 24 ms (5 res), "inventory catalog site" #1 43 ms (5 res), "inventory catalog site" #2 39 ms (5 res), "inventory catalog site" #3 36 ms (5 res)
- stock query: #1 29008 ms (5 res), #2 555 ms (5 res), #3 397 ms (5 res)
- fork lex: "simulation events" #1 17 ms (5 res), "simulation events" #2 11 ms (5 res), "simulation events" #3 10 ms (5 res), "inventory catalog site" #1 10 ms (5 res), "inventory catalog site" #2 12 ms (5 res), "inventory catalog site" #3 12 ms (5 res)
- fork query: #1 16756 ms (5 res), #2 112 ms (5 res), #3 85 ms (5 res)

Processes with three sessions idle (stock): pid ppid rss_kb %cpu command
```
   35886 34351 104032 0 /Users/kundeng/.local/share/mise/installs/node/24.12.0/bin/node /Users/kundeng/.local/share/mise/installs/node/24.12.0/lib/node_modules/@to
   35887 34351 103392 0 /Users/kundeng/.local/share/mise/installs/node/24.12.0/bin/node /Users/kundeng/.local/share/mise/installs/node/24.12.0/lib/node_modules/@to
   35888 34351 103664 0 /Users/kundeng/.local/share/mise/installs/node/24.12.0/bin/node /Users/kundeng/.local/share/mise/installs/node/24.12.0/lib/node_modules/@to
```

Processes with three sessions idle (fork): pid ppid rss_kb %cpu command
```
   39646 38193 65632 0 /Users/kundeng/.local/share/mise/installs/node/24.12.0/bin/node /Users/kundeng/.local/share/project-git/qmd-worktrees/live/dist/cli/qmd.js m
   39647 39646 5359504 33.5 /Users/kundeng/.local/share/mise/installs/node/24.12.0/bin/node /Users/kundeng/.local/share/project-git/qmd-worktrees/live/dist/cli/qmd
   39648 38193 65360 0 /Users/kundeng/.local/share/mise/installs/node/24.12.0/bin/node /Users/kundeng/.local/share/project-git/qmd-worktrees/live/dist/cli/qmd.js m
   39650 38193 65520 0 /Users/kundeng/.local/share/mise/installs/node/24.12.0/bin/node /Users/kundeng/.local/share/project-git/qmd-worktrees/live/dist/cli/qmd.js m
```

## Reading the numbers

- **Processes.** Stock: one full server per session (three here; the real machine had 28). Fork: one daemon plus one 65 MB proxy per session. The daemon lingers five minutes after the last session leaves (the benchmark's own process filter missed it after the sessions closed; `settle.log` shows it alive).
- **RSS.** The stock idle figure (304 MB) is three servers that have loaded no model yet; the stock loaded figure (6.3 GB) is after one session ran a full query, so one server holds the three models and the other two still hold nothing. With three sessions all querying, stock loads the models three times. The fork's "idle" figure (5.4 GB) was taken while the daemon was still embedding 13 documents that had changed under the project between the CLI scan and the daemon start (`bench-fork-daemon.log`: 793 chunks in 31 s), so it is a loaded, working daemon, not an idle one. The fork's loaded figure (10.3 GB) is the daemon holding the embedding model with its batch contexts plus the query and rerank models. The settled figures below show the memory is not released after the model inactivity timeout.
- **Idle CPU.** The stock 60 s window was truly idle (0 CPU-seconds). The fork's window overlapped the same 31 s embedding pass, so its 11 CPU-seconds are embedding work, not idle cost. The settled measurement below is the idle figure.
- **Latency.** Keyword search is faster through the daemon (10 to 17 ms versus 24 to 43 ms); both are dominated by process and transport overhead on a 287-document index. The first full query pays model loading in both (17 to 29 s); warm full queries are 85 to 112 ms through the daemon versus 400 to 555 ms stock. The embedding pass itself was slower in the fork run (116 s versus 90 s), most likely GPU contention with the stock daemon's lingering model memory and with other sessions on the machine; it is the same code path.
- **Save to searchable.** Stock: the file is invisible until someone runs `qmd update` (485 ms) and `qmd embed` (28 s for one file, dominated by model load). Fork: keyword-searchable 449 ms after the save and embedded 640 ms after the save with the model warm.

## Settled state (daemon with three idle sessions, nothing to index)

Measured right after the benchmark on the same daemon (`settle.mjs`, log `settle.log`), three new idle proxies attached, no file changes.

| Measure | Fork daemon |
|---|---|
| Daemon RSS with the three models loaded, nothing to do | 10,132 MB |
| Each idle proxy | 64 MB |
| Idle CPU, minute 1 (models loaded) | 0.00 CPU-s (0.00% of a core) |
| Idle CPU, minute 6 | 0.01 CPU-s (0.02% of a core) |
| Daemon RSS after 5+ minutes without a query | 10,191 MB (not released) |
| After the sessions close | daemon alone, 10,191 MB, lingering for its idle timeout |

Two conclusions. An idle daemon costs no CPU, with or without models loaded, so the watcher design holds: nothing polls. The daemon's resident memory does not fall after the five-minute model inactivity timeout, so a daemon that has answered one full query keeps about 10 GB resident until it exits. Stock qmd has the same behaviour per session (its README says contexts are disposed after five minutes idle while models stay loaded), at about 6 GB per session that ran a full query; with three querying sessions that is 18 GB against the daemon's 10 GB, but a single lightly used session is cheaper under stock. The difference between 6 GB and 10 GB is the embedding model's batch context pool, which the daemon uses for live embedding and a stock session never allocates. Releasing models on inactivity, or sizing the embed pool for one document at a time, is the first follow-up (see the report's open questions).

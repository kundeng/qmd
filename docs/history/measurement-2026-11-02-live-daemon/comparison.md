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

# Measurement: daemon memory with the old and new embedding pool (2026-11-08)

Commit: `live/05-daemon-memory` at ec7411b, built to `dist/`, run as `node dist/cli/qmd.js`. Data: a quiet copy of inventory-catalog (`~/.local/share/qmd-bench/quiet/inventory-catalog`, 588 Markdown and code files, no other process writing to it), two collections as in the 2026-11-02 run. Script: `memory.mjs <label> <extra-env>`; one run with `QMD_EMBED_PARALLELISM=8` (what the daemon did before this change, since `qmd embed` sized its pool from free VRAM) and one with the new default of two contexts. Each run: the daemon's start-up reconcile embeds everything, then two uncached full queries load the expansion and rerank models, then six idle minutes. Models are configured to unload after five idle minutes.

| Point | Pool of 8 (before) | Pool of 2 (after) |
|---|---|---|
| Daemon RSS before embedding | 2,283 MB | 1,943 MB |
| Start-up embed of 3,374 chunks | 99 s, RSS 5,291 MB | 97 s, RSS 2,067 MB |
| After the first full query | 10,085 MB | 5,518 MB |
| After the second full query | 10,145 MB | 5,624 MB |
| Idle minutes 1 to 4 | 10,145 MB | 5,489 MB |
| Idle minute 5 (models unloaded) | 883 MB | 814 MB |
| Idle minute 6 | 883 MB | 814 MB |

Reading: the pool of eight embedding contexts cost about 4.5 GB resident while loaded and bought nothing on this machine (99 s versus 97 s for the same backlog). With two contexts the loaded daemon sits where one stock session sat on 2026-11-02 (5.5 GB against 6.3 GB), shared by every session. The five-minute unload works and returns the process to under 1 GB; the 2026-11-02 "not released" reading came from other sessions editing the live project every minute or two during the settle window, which re-embedded and re-armed the timer (see `bench-fork-daemon.log` in the 2026-11-02 record). `rss-probe.mjs` shows the same release on a single process: 5 GB to 826 MB on `unloadIdleResources`.

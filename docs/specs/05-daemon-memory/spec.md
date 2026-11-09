---
spec_id: 05-daemon-memory
status: CLOSED
closed_as: SHIPPED
since: 2026-11-08
until: null
epic: live-index
features: [daemon-embed-pool, per-instance-session-veto]
supersedes: []
superseded_by: null
depends_on: [04-project-collections]
anchors: [live-index-daemon]
---

# Requirements: Daemon Memory

## Scope

The 2026-11-02 measurement showed the daemon holding about 10 GB resident after a full query and live embedding, against about 6 GB for one stock session, and apparently not releasing it after the five-minute model timeout. This sprint finds why and brings the daemon's steady-state memory down. Design: `docs/design/live-index-daemon.md`.

## Mental Model And Invariants

- Model: the daemon's memory is the models (embedding, query expansion, reranker) plus the contexts created for them; contexts for embedding are a pool sized for throughput.
- Invariant: models and contexts are released five minutes after the last use, and never under a running search or embedding.

## Decisions And Corrections

- 2026-11-08: the "not released" reading was a measurement artifact. The daemon log shows other sessions editing inventory-catalog every minute or two during the settle window, each edit re-embedding and re-arming the model timer. A probe on the same index (`measurement-2026-11-08-daemon-memory/`) shows `unloadIdleResources` taking the process from about 5 GB to 826 MB.
- 2026-11-08: the daemon caps its embedding context pool at two (`QMD_EMBED_PARALLELISM` set by the user wins), decided by the agent; reversible by changing `DAEMON_EMBED_PARALLELISM` in `src/daemon/daemon.ts`.

## Requirements

### R1. Idle unload honours the instance's own sessions

WHEN a per-store `LlamaCpp` has a session or operation open, THE idle timer SHALL not unload it; WHEN the last session closes with contexts loaded, THE idle clock SHALL start.

### R2. Right-sized embed pool

WHEN the daemon embeds, THE embedding context pool SHALL hold two contexts unless `QMD_EMBED_PARALLELISM` is set.

### R3. Measured

The daemon's RSS after start-up embedding, after a full query, and after six idle minutes SHALL be recorded for the old pool size and the new one on a quiet copy of inventory-catalog.

# Design

`src/llm.ts`: `LlamaCpp` gains `activeSessions` and `inFlightOperations`, updated by `LLMSessionManager.acquire/release/operationStart/operationEnd`, and `canUnloadNow()`; the idle timer reschedules while either is non-zero. `src/daemon/daemon.ts`: `runIndexDaemon` sets `QMD_EMBED_PARALLELISM=2` when unset before opening the store, which `resolveSafeParallelism` reads per pool creation.

## Change Map

| Path | Change |
|---|---|
| `src/llm.ts` | per-instance session counters; timer veto |
| `src/daemon/daemon.ts` | `DAEMON_EMBED_PARALLELISM` |
| `test/llm-session-veto.test.ts` | new |
| `CHANGELOG.md` | Fixed and Added entries |

# Tasks

- [x] 1. per-instance session veto (`test/llm-session-veto.test.ts`, 2 tests)
- [x] 2. daemon embed pool cap
- [x] 3. measurement on a quiet copy, old versus new pool, recorded in `docs/history/measurement-2026-11-08-daemon-memory/`
- [x] 4. CHANGELOG

## Log
- 2026-11-08: committed as ec7411b on `live/05-daemon-memory`; `test/llm-session-veto.test.ts` and `test/llm.test.ts` pass under vitest (54). Measurement running.
- 2026-11-08: closed as shipped. Measurement `docs/history/measurement-2026-11-08-daemon-memory/README.md`: loaded daemon 10,145 MB with the old pool, 5,624 MB with two contexts, both 0.8 to 0.9 GB after the five-minute unload; start-up embedding of 3,374 chunks 99 s versus 97 s.

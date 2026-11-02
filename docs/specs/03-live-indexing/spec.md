---
spec_id: 03-live-indexing
status: ACTIVE
closed_as: null
since: 2026-11-02
until: null
epic: live-index
features: [file-watcher, incremental-reindex, connect-reconcile, staleness-flags, cli-delegation]
supersedes: []
superseded_by: null
depends_on: [02-daemon-proxy]
anchors: [live-index-daemon]
---

# Requirements: Live Indexing

## Scope

The daemon watches every collection root with native file events, re-indexes and re-embeds only the files that changed about two seconds after they change, reconciles the whole index when it starts, flags results whose files are still pending, and runs `qmd update` and `qmd embed` on behalf of the CLI while it holds the writer lock. Design: `docs/design/live-index-daemon.md`.

## Mental Model And Invariants

- Model: the files are the truth; the index follows them within seconds; a search never blocks on indexing.
- Invariant: only the daemon writes while it runs; the watcher's writes and control requests go through one serialized queue.
- Invariant: a change the watcher missed (daemon down, event dropped) is caught by the next start-up reconcile or control `update`.
- Invariant: an idle daemon uses no CPU: no polling, no timers shorter than the sweep.

## Configuration

| Key | Plane | Owner | Default |
|---|---|---|---|
| `QMD_NO_WATCH` | runtime | `src/daemon/watcher.ts` | unset |
| `QMD_WATCH_DEBOUNCE_MS` | runtime | `src/daemon/watcher.ts` | 2000 |

## Requirements

### R1. Watch

WHEN the daemon starts, THE watcher SHALL install one recursive `fs.watch` per collection root (per-directory fallback on platforms without recursive support) and filter events by the collection's glob, ignore list, hidden-path rule and the built-in excluded directories.

### R2. Debounce and apply

WHEN files change, THE indexer SHALL re-index exactly those files after `QMD_WATCH_DEBOUNCE_MS` of quiet (300 ms when at most two are pending), deactivating documents whose files are gone, then embed pending hashes for that collection, then remove orphaned vectors and content.

### R3. Directory events and bursts

WHEN an event names a directory, or more than 500 files are pending, THE indexer SHALL run a full `reindexCollection` for that collection instead.

### R4. Reconcile on start

WHEN the daemon starts, THE indexer SHALL run `reindexCollection` for every collection and then embed pending hashes, before or while serving sessions (sessions never wait for it).

### R5. Staleness

WHEN a `query` result's file is pending, THE result SHALL carry `stale: true` and the text summary SHALL open with a line naming the number of pending files; THE `status` tool SHALL report the watcher state per collection (pending count, degraded reason).

### R6. Delegation

WHEN `qmd update` or `qmd embed` finds the writer lock held by a daemon, THE CLI SHALL send a control request over the socket, print the daemon's progress and summary in the CLI's current format, and exit 0; WHEN the holder is not a daemon, the CLI SHALL fail fast as in sprint 01.

### R7. Degradation

WHEN `fs.watch` fails with EMFILE, ENFILE or ENOSPC, or five consecutive applies fail, THE watcher SHALL stop for that collection, report the reason in `status`, and the daemon SHALL keep serving.

## Non-Functional Requirements

- Save to BM25-searchable under 3 s for one markdown file; to vector-searchable under 10 s with the embed model warm.
- Idle daemon CPU under 0.1% averaged over a minute.

## Out Of Scope

- Watching paths outside collection roots; polling.

# Design

Anchored in `docs/design/live-index-daemon.md`: dataflow, workflows "A file save becomes searchable" and "qmd update while the daemon runs", algorithms "Watcher and debounce", "Incremental re-index", "LiveIndexer serialization", "Control requests".

## Change Map

| Path | Change |
|---|---|
| `src/store.ts` | `reindexFiles` factored out of `reindexCollectionIn`; both share the per-file body |
| `src/daemon/watcher.ts` | new `CollectionWatcher` |
| `src/daemon/live-index.ts` | new `LiveIndexer` |
| `src/daemon/control.ts` | new control protocol |
| `src/daemon/daemon.ts` | start watcher and indexer; route control lines |
| `src/mcp/server.ts` | `stale` flag, pending line, `status.daemon` |
| `src/cli/qmd.ts` | `update` and `embed` delegate |
| `test/reindex-files.test.ts` | create, modify, delete, rename, empty, oversize, outside-root |
| `test/watcher.test.ts` | filtering, debounce, quick path, directory event, degrade (injected `fs.watch`) |
| `test/mcp-daemon-live.test.ts` | end to end: save → found; delete → gone; `qmd update` delegated |
| `README.md`, `skills/qmd/SKILL.md`, `CHANGELOG.md` | |

## Verification

- `bun run test:types && bun run lint && bun run test:unit`.
- End-to-end latency recorded in `docs/history/measurement-2026-11-02-live-daemon/`.

# Tasks

- [x] 1. Foundation
  - [x] 1.1 `reindexFiles` in `store.ts`; `reindexCollectionIn` uses it
- [x] 2. Core
  - [x] 2.1 `watcher.ts`
  - [x] 2.2 `live-index.ts` with the serialized queue, reconcile, apply, embed, cleanup
  - [x] 2.3 wire into `daemon.ts`; start-up reconcile
  - [x] 2.4 staleness in `server.ts`
  - [x] 2.5 `control.ts`; CLI delegation
- [x] 3. Tests
  - [x] 3.1 reindexFiles units
  - [x] 3.2 watcher units
  - [x] 3.3 end to end
- [x] 4. Polish And Docs
  - [x] 4.1 README, skill, CHANGELOG

## Log
- 2026-11-02: spec written.
- 2026-11-02: implemented on branch `live/03-live-indexing`. `src/store.ts`: the per-file scan body moved into `CollectionScan`, shared by `reindexCollection` and the new `reindexFiles`; `src/daemon/watcher.ts` (`CollectionWatcher`), `src/daemon/live-index.ts` (`LiveIndexer`, one serialized write queue), `src/daemon/control.ts` (control protocol: `update`, `embed`, `reload`, `cleanup`, `status`), `src/daemon/daemon.ts` (watchers, start-up reconcile, control handling, staleness adapter), `src/mcp/server.ts` (`stale` flag, pending line, `Live indexing` status line, default collections read per call so a session sees a collection added later), `src/cli/qmd.ts` (update, embed, cleanup, collection add/remove/rename delegate to a daemon holder; hooks still run in the CLI). Beyond the spec: `collection add|remove|rename` and `cleanup` delegate too, through a `reload` and a `cleanup` control op, because a daemon that holds the writer lock would otherwise block every collection change while any Claude session is open. Measured in the smoke run (`QMD_WATCH_DEBOUNCE_MS=300`): a saved file is keyword-searchable 350 ms after the save, a deleted file is gone within one flush, a new directory triggers a full scan that completes in under 400 ms on a 3-file collection; start-up reconcile of 2 files took 8 ms. Tests: `test/reindex-files.test.ts` (8), `test/watcher.test.ts` (12), `test/mcp-daemon-live.test.ts` (2 end to end), all passing under vitest on Node 24.12.0.
- 2026-11-02: committed as d519aad on `live/03-live-indexing`; `test/cli.test.ts` 175 passing under vitest after the delegation changes; `test/mcp-daemon-live.test.ts` passing under bun once `removeCollection` counted rows before deleting (bun:sqlite reports a statement's `changes` from the connection counter later statements have moved). Full-suite run recorded at close.

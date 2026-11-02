# File watcher: Node's fs.watch, no new dependency

Status: decided by the agent; the owner may reverse.

## Decision

`src/daemon/watcher.ts` uses `fs.watch(root, { recursive: true })` per collection root, with a per-directory walk as the fallback when a platform throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, and a 2 s debounce (300 ms when at most two files are pending).

## Prior art surveyed (2026-11-02)

| Candidate | Licence | Notes |
|---|---|---|
| Node `fs.watch` recursive | Node | FSEvents on macOS, ReadDirectoryChangesW on Windows, inotify-based recursive on Linux since Node 20 (checked: `recursive ok` on Node 24.12.0 here). What codegraph 1.6.2 uses (`dist/sync/watcher.js`), after it removed chokidar over macOS fd exhaustion (#644). |
| chokidar 4.x | MIT | mature, polling fallback; adds a dependency and its own fd behaviour on macOS |
| @parcel/watcher 2.x | MIT | native addon, per-platform prebuilds; a second native dependency next to node-llama-cpp and better-sqlite3 |

## Why fs.watch

qmd's dependency list is pinned and small; upstream review is easier without a new package; codegraph has run this design across its user base. The event stream is coalesced into a pending set, so fs.watch's known duplicate and coarse events cost nothing.

## Consequences

A directory rename or removal is reported as one event for the directory; the watcher treats that as a request for a full collection reconcile, which the `file_sync_state` fast path makes cheap.

---
spec_id: 04-project-collections
status: CLOSED
closed_as: SHIPPED
since: 2026-11-02
until: null
epic: live-index
features: [init-presets, orphan-cleanup-cycle]
supersedes: []
superseded_by: null
depends_on: [03-live-indexing]
anchors: [live-index-daemon]
---

# Requirements: Project Collections

## Scope

`qmd init` in a repository produces a project index that covers its documentation and its code, kept live by the daemon, with the chunks of replaced content cleaned up as part of every indexing cycle. Design: `docs/design/live-index-daemon.md`.

## Mental Model And Invariants

- Model: a project index is `.qmd/index.yml` (checked in, trusted per `qmd trust`) plus `.qmd/index.sqlite` (local, ignored); `qmd mcp` run from anywhere inside the project uses it.
- Invariant: `qmd init` never overwrites an existing collection of the same name.
- Invariant: the code collection uses the AST-aware chunker for the languages tree-sitter supports here (TypeScript, JavaScript, Python, Go, Rust) and regex chunking for everything else.

## Requirements

### R1. Presets

WHEN `qmd init` runs in a directory with no `.qmd/index.yml`, THE CLI SHALL write two collections: `docs` with pattern `**/*.md` and `code` with pattern `**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs}`, both rooted at the project directory with the built-in excluded directories, and print them. WHEN a config exists, THE CLI SHALL add only the missing preset collections and leave the rest untouched.

### R2. Ignore files

WHEN `qmd init` creates `.qmd/`, THE CLI SHALL write `.qmd/.gitignore` containing `index.sqlite*` and `.qmd-*.lock`, and print the Dropbox hint `xattr -w com.dropbox.ignored 1 .qmd` on macOS.

### R3. Orphan cleanup in the cycle

WHEN an incremental apply replaces a document's hash, THE indexer SHALL remove the vector rows and content of hashes no active document references at the end of that cycle, so `qmd status` reports zero orphaned chunks after the cycle.

### R4. Code chunking

WHEN the daemon embeds, THE indexer SHALL pass `chunkStrategy: "auto"`.

## Out Of Scope

- Registering project indexes in the global index; cross-project search.

# Design

## Change Map

| Path | Change |
|---|---|
| `src/cli/qmd.ts` | `initLocalIndex` presets and `.gitignore` |
| `src/daemon/live-index.ts` | cleanup step after apply; `chunkStrategy: "auto"` |
| `test/cli.test.ts` | `qmd init` cases |
| `test/mcp-daemon-live.test.ts` | orphan count zero after an edit cycle |
| `README.md`, `skills/qmd/SKILL.md`, `CHANGELOG.md` | |

## Verification

- `bun run test:unit`; end-to-end on `~/Dropbox/Projects/inventory-catalog` recorded in the measurement file.

# Tasks

- [x] 1. `initLocalIndex` presets and ignore file
- [x] 2. cleanup step and auto chunking in the cycle (landed in 03: `LiveIndexer.cleanupVectors` after every apply that updated or removed, `chunkStrategy: "auto"` default)
- [x] 3. tests
- [x] 4. docs and CHANGELOG

## Log
- 2026-11-02: spec written.
- 2026-11-02: committed as 35e1a86 on `live/04-project-collections`. `initLocalIndex` adds `docs` and `code` presets rooted at the project (absolute path, as `collection add` writes; relative paths are resolved only by the trust check, `src/trust.ts:200`, not by the scanner, so a cloned `.qmd/index.yml` still names the original machine's path: open item) and writes `.qmd/.gitignore`. Tests: `test/cli.test.ts` "CLI Init Command" (4) under vitest and bun. R3 (orphan cleanup after replaced hashes) and R4 (auto chunking) were delivered by sprint 03's `LiveIndexer`; verification on inventory-catalog is in the measurement record.
- 2026-11-02: closed as shipped at 35e1a86 (`live/main`). Full suite: vitest 63 files all passing; bun 1580 passing, 3 failing: the two pre-existing memory-budget tests, plus `cli.test.ts` "named-index daemon does not collide with the default daemon pidfile (#772)", whose `waitForServer` timed out while the benchmark daemon still held 10 GB on the machine; the same describe block passes 11/11 on an immediate rerun (`suite-04-project-collections.log`). End-to-end verification on inventory-catalog: `measurement-2026-11-02-live-daemon/README.md`.

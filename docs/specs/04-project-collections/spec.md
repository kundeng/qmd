---
spec_id: 04-project-collections
status: DRAFT
closed_as: null
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

- [ ] 1. `initLocalIndex` presets and ignore file
- [ ] 2. cleanup step and auto chunking in the cycle
- [ ] 3. tests
- [ ] 4. docs and CHANGELOG

## Log
- 2026-11-02: spec written.

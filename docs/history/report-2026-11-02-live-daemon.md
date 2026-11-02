# Report: qmd as a live search engine (2026-11-02)

What was asked: make the kundeng/qmd fork a robust, live search engine for projects and notes by porting codegraph's daemon design, in four PR-sized branches, with a design first and measurements after. This report is the hand-off: the design, the branches, the measurements, and what is open. Everything it cites is in the repository on branch `live/00-spec` (docs) and `live/main` (code).

## The design in one paragraph

One detached daemon per index file holds the index open, holds the index writer lock, watches every collection directory with native file events, re-indexes and re-embeds only the files that change about two seconds after they change, and serves every MCP client over a Unix socket. `qmd mcp`, the process a Claude session spawns, is a byte pipe to that daemon after one hello line; it falls back to the old in-process server when no daemon can be used and always when `QMD_NO_DAEMON=1`. The daemon exits five minutes after its last client leaves, sweeps clients whose process died, and a proxy whose host dies exits on its own. `qmd update`, `qmd embed`, `qmd cleanup` and `qmd collection add|remove|rename` run through the daemon while it holds the lock. `qmd init` gives a project a `docs` and a `code` collection. Design anchor with diagrams, APIs, dataflow, change map and pseudocode: `docs/design/live-index-daemon.md`. Decisions: `docs/decisions/`.

## Branches and the proposed upstream PRs

Stacked, each the unit of one PR, in this order. Nothing was opened against `tobi/qmd`; the owner decides on each.

| Order | Branch on kundeng/qmd | Proposed PR title | Spec |
|---|---|---|---|
| 1 | `live/01-writer-lock` | fix(index): one writer lock for update, embed, collection and cleanup | `docs/specs/01-writer-lock` (SHIPPED) |
| 2 | `live/02-daemon-proxy` | feat(mcp): share one daemon per index across stdio sessions | `docs/specs/02-daemon-proxy` (SHIPPED) |
| 3 | `live/03-live-indexing` | feat(index): keep the index current from file events | `docs/specs/03-live-indexing` (SHIPPED) |
| 4 | `live/04-project-collections` | feat(init): docs and code collections for a project index | `docs/specs/04-project-collections` |
| — | `live/main` | the four together, for running the fork | |
| — | `live/00-spec` | design, specs, decisions, measurements; not for upstream | |

Each code branch carries its CHANGELOG lines and README text. Each spec's Log names the commit, the tests and the full-suite run.

## Verification

- `bun run test:types` and `bun run lint` are clean on every branch.
- Full suite (`bun run test:unit`: vitest under Node 24.12.0, then bun 1.3.6) on the sprint 02 and sprint 03 commits: vitest 60 and 63 files all passing; bun 1557 and 1579 passing with two failures, `store.test.ts` "legacy fingerprint adoption ... within a 16 MiB SQLite budget" and `doctor-vector-sampling.test.ts` "... within a 32 MiB SQLite budget", which fail identically on untouched upstream `main` (86d2365) on this machine (`measurement-2026-11-02-live-daemon/bun-budget-main.log`).
- New tests: writer lock (15 + 3 CLI), daemon paths and hello (10), client registry (6), daemon end to end (4), reindexFiles (8), watcher (12), live indexing end to end (2), init (4).

## Measurements

Full record with method, raw logs and the rerunnable scripts: `docs/history/measurement-2026-11-02-live-daemon/README.md`. Data: inventory-catalog, 99 Markdown files and 188 code files in two collections; three MCP sessions driven by a script; stock `@tobilu/qmd` 2.8.3 versus `live/main` (35e1a86), both run as `node <entry> mcp`.

| Measure | Stock 2.8.3 | Fork |
|---|---|---|
| Processes for three sessions | 3 servers (28 on the real machine before this work) | 1 daemon + 3 proxies of 64 MB |
| RSS, three sessions, no model loaded | 304 MB | 65 MB per proxy; daemon as below |
| RSS after a full query | 6.3 GB per session that queried | 10.1 GB in the daemon, shared by every session; not released after the 5-minute model timeout |
| Idle CPU over 60 s | 0.00 CPU-s | 0.00 CPU-s (0.01 in a later minute) |
| Keyword query, warm | 24 to 43 ms | 10 to 17 ms |
| Full query (expand + rerank), warm | 400 to 555 ms | 85 to 112 ms |
| Full query, first (model load) | 29 s | 17 s |
| Save → keyword-searchable | never, until `qmd update` (485 ms) | 449 ms |
| Save → embedded | after `qmd embed` (28 s for one file, model load dominated) | 640 ms with the model warm |
| Full embed of 2,176 chunks, cold | 90 s | 116 s (same code; GPU shared with the lingering stock run) |
| Sessions close | each server exits | proxies exit; the daemon lingers 300 s then exits |

Earlier baseline from the machine itself, before any change: 28 stock servers alive from Claude sessions, 56 processes, 3,412 MB RSS (`baseline-stock-processes.txt`).

## Open questions and follow-ups

1. **Daemon memory after queries.** The daemon holds about 10 GB resident once it has answered a full query and embedded, and the five-minute model inactivity timeout does not bring it down (`settle.log`). Stock has the same per-session behaviour at about 6 GB. Candidates: dispose models (not only contexts) on inactivity in the daemon, and size the embedding context pool for the one-document batches live embedding produces. Technical, reversible; I would do it next.
2. **Project config portability.** `qmd init` writes absolute collection paths, as `collection add` does, because the scanner resolves only absolute paths (the trust check resolves relative ones). A `.qmd/index.yml` cloned to another machine names the wrong root. Making the scanner resolve relative paths against the project is a small upstream change worth its own PR.
3. **Daemon per project versus per machine.** Each project index gets its own daemon and, while embedding, its own copy of the embedding model. With two or three projects open at once that is 2 to 3 daemons. The design keeps one writer per database; a per-machine daemon serving several indexes would share models at the cost of routing sessions by index inside one process. Decided per index for now (`docs/decisions/2026-11-02-01-daemon-unit.md`); revisit if the owner runs many projects at once.
4. **Two bun test failures** (`store.test.ts` 16 MiB budget, `doctor-vector-sampling.test.ts` 32 MiB budget) fail identically on untouched upstream main on this machine. Not ours; worth an upstream issue with the bun version.
5. **Upstream PRs.** Four branches are ready in order. Opening them on `tobi/qmd` is the owner's call (`docs/decisions/2026-11-02-05-pr-split.md`); the docs branch stays on the fork.
6. **Runtime for the registered server.** The fork's `bin/qmd` picks bun when `bun.lock` and bun are present, so the daemon the registration command below starts runs under bun (87 MB RSS at start in a check), while the benchmark ran under Node. Both pass the suite; the choice is upstream's launcher logic.
7. **Upgrades.** A proxy whose version differs from the running daemon serves in-process and the old daemon exits on idle. After installing a new build, `qmd mcp stop` ends the old daemon at once.

## How to use the fork now

The MCP registration was not changed. When ready:

```bash
claude mcp add --scope user --env QMD_SOURCE_MODE=0 qmd -- /Users/kundeng/.local/share/project-git/qmd-worktrees/live/bin/qmd mcp
```

`QMD_SOURCE_MODE=0` makes the checkout's launcher run the built `dist/` (built on 2026-11-02 from `live/main`; rebuild with `node scripts/build.mjs` after pulling). The first session starts the daemon for the global index; `qmd status` shows it; `qmd mcp stop` ends it.

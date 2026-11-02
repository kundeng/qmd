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

MEASUREMENTS_PLACEHOLDER

## Open questions and follow-ups

OPEN_PLACEHOLDER

## How to use the fork now

The MCP registration was not changed. When ready:

```bash
claude mcp add --scope user --env QMD_SOURCE_MODE=0 qmd -- /Users/kundeng/.local/share/project-git/qmd-worktrees/live/bin/qmd mcp
```

`QMD_SOURCE_MODE=0` makes the checkout's launcher run the built `dist/` (built on 2026-11-02 from `live/main`; rebuild with `node scripts/build.mjs` after pulling). The first session starts the daemon for the global index; `qmd status` shows it; `qmd mcp stop` ends it.

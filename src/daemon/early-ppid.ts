/**
 * Parent pid captured as early as possible in the process's life.
 *
 * The proxy's parent watchdog treats a changed `process.ppid` as "the MCP host
 * is gone". A host killed within the first milliseconds of our start would
 * reparent us before any later capture ran; the baseline would then read the
 * reaper's pid and never diverge. `src/cli/qmd.ts` imports this module first,
 * before the database module's top-level awaits, so the capture runs before
 * anything that can yield.
 */
export const EARLY_PPID: number = process.ppid;

/**
 * Child helper for writer-lock cross-process tests.
 * Args: <dbPath> <mode> <holdMs> [ignored qmd tokens...]
 * Prints HOLD once the lock is taken and RELEASED after holdMs.
 */
import { tryAcquireWriterLock, type WriterMode } from "../../src/daemon/writer-lock.ts";

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  const mode = (process.argv[3] ?? "embed") as WriterMode;
  const holdMs = Number(process.argv[4] ?? "1000");
  if (!dbPath || !Number.isFinite(holdMs)) {
    console.error("usage: writer-lock-holder.ts <dbPath> <mode> <holdMs>");
    process.exit(2);
  }

  const lock = tryAcquireWriterLock(dbPath, mode);
  if (lock.kind === "taken") {
    console.error("child failed to acquire");
    process.exit(2);
  }

  process.stdout.write("HOLD\n");
  await new Promise((r) => setTimeout(r, holdMs));
  lock.release();
  process.stdout.write("RELEASED\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

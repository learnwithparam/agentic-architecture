// The journal: a file that should remember each finished step of a run, with its result.
// A worker that starts again should read the journal first and skip every step already done.

// TODO: open the journal file named by JOURNAL_DB with bun:sqlite.
// Before the work, look the step up: if it is there, return its saved result.
// After the work, save the result. Today the journal remembers nothing.
export async function step<Result>(name: string, work: () => Promise<Result>): Promise<Result> {
  console.log(`step ${name}`);
  return work();
}

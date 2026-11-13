// The journal: a file that remembers each finished step of a run, with its result.
// A worker that starts again reads the journal first and skips every step already done.
import { Database } from "bun:sqlite";

const journal = new Database(String(process.env.JOURNAL_DB), { create: true });
journal.exec(
  "CREATE TABLE IF NOT EXISTS steps (run TEXT, step TEXT, result TEXT, PRIMARY KEY (run, step))",
);

const runId = String(process.env.RUN_ID);
const findStep = journal.query("SELECT result FROM steps WHERE run = ? AND step = ?");
const saveStep = journal.prepare("INSERT INTO steps (run, step, result) VALUES (?, ?, ?)");

// A durable step. If the journal has this step, return its saved result and do no work.
// If not, do the work, save the result, and only then return it.
export async function step<Result>(name: string, work: () => Promise<Result>): Promise<Result> {
  const saved = findStep.get(runId, name) as { result: string } | null;
  if (saved) return JSON.parse(saved.result) as Result;
  const result = await work();
  saveStep.run(runId, name, JSON.stringify(result ?? null));
  return result;
}

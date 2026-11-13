// The journal: it remembers each finished step of a run, with its result.
// Here it lives in memory, so it is gone when the worker dies.
const finishedSteps = new Map<string, unknown>();

export async function step<Result>(name: string, work: () => Promise<Result>): Promise<Result> {
  if (finishedSteps.has(name)) return finishedSteps.get(name) as Result;
  const result = await work();
  finishedSteps.set(name, result);
  return result;
}

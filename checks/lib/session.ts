// Run a scenario once per folder and let every rule read its result.
// verify.ts calls each rule with the same folder, so the expensive part runs one time.
const resultsByScenario = new Map<string, Promise<unknown>>();

export function once<Result>(
  scenarioName: string,
  folder: string,
  scenario: (folder: string) => Promise<Result>,
): Promise<Result> {
  const cacheKey = `${scenarioName}::${folder}`;
  if (!resultsByScenario.has(cacheKey)) {
    // A scenario that throws still gives every rule a result, so each rule can fail plainly.
    const result = scenario(folder).catch((error) => ({ error: String(error?.message ?? error) }));
    resultsByScenario.set(cacheKey, result);
  }
  return resultsByScenario.get(cacheKey) as Promise<Result>;
}

// Behaviour that depends on a model is judged over three fresh runs in replay mode.
// All three must pass.
export async function threeRuns<Result>(
  run: (runNumber: number) => Promise<Result>,
  passes: (result: Result) => boolean,
): Promise<boolean> {
  for (let runNumber = 1; runNumber <= 3; runNumber++) {
    const result = await run(runNumber);
    if (!passes(result)) return false;
  }
  return true;
}

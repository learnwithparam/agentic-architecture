// Run a scenario once per folder and let every rule read its result.
// verify.ts calls each rule with the same folder, so the expensive part runs one time.
const cache = new Map<string, Promise<any>>();

export function once<T>(key: string, dir: string, scenario: (dir: string) => Promise<T>): Promise<T> {
  const k = `${key}::${dir}`;
  if (!cache.has(k)) cache.set(k, scenario(dir).catch((e) => ({ error: String(e?.message ?? e) }) as T));
  return cache.get(k)!;
}

// Behaviour that depends on a model is judged over three fresh runs in replay mode: all three must pass.
export async function threeRuns<T>(run: (n: number) => Promise<T>, pass: (r: T) => boolean): Promise<boolean> {
  for (let n = 1; n <= 3; n++) if (!pass(await run(n))) return false;
  return true;
}

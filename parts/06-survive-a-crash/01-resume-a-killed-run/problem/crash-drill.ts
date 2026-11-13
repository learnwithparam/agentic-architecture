// biome-ignore-all lint/style/useNamingConvention: settings like CRASH_AFTER are in capitals.
// The crash drill. Do not change this file.
// When CRASH_AFTER names a step, the worker dies right after that step, once per drill.
// Exit code 137 is what a process killed by the system returns.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function crashDrill(stepName: string): void {
  const marker = join(String(process.env.STATE_DIR), "worker-crashed");
  if (process.env.CRASH_AFTER !== stepName || existsSync(marker)) return;
  writeFileSync(marker, `worker died right after ${stepName}\n`);
  process.exit(137);
}

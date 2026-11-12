// Start the learner's work the way the platform would: read platform.toml in their folder,
// run the start command for a service, and wait for GET /health. Any language passes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startService, type Service } from "../../world/proc";

export function platformToml(dir: string): Record<string, any> {
  const p = join(dir, "platform.toml");
  return existsSync(p) ? (Bun.TOML.parse(readFileSync(p, "utf8")) as any) : {};
}

export async function startLearner(dir: string, service: string, env: Record<string, string>, waitMs?: number): Promise<Service> {
  const cmd = platformToml(dir)[service]?.start;
  if (!cmd) throw new Error(`platform.toml has no [${service}] start command`);
  return startService(["sh", "-c", `exec ${cmd}`], { cwd: dir, env, waitMs });
}

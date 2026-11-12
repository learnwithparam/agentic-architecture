// Start the learner's work the way the platform would: read platform.toml in their folder,
// run the start command for a service, and wait for GET /health. Any language passes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Service, startService } from "../../world/proc";

// Each [section] of platform.toml, such as [learner] or [gateway], holds named values.
export type PlatformToml = Record<string, Record<string, unknown> | undefined>;

export function platformToml(folder: string): PlatformToml {
  const path = join(folder, "platform.toml");
  if (!existsSync(path)) return {};
  return Bun.TOML.parse(readFileSync(path, "utf8")) as PlatformToml;
}

export async function startLearner(
  folder: string,
  service: string,
  settings: Record<string, string>,
  waitMs?: number,
): Promise<Service> {
  const startCommand = platformToml(folder)[service]?.start;
  if (!startCommand) throw new Error(`platform.toml has no [${service}] start command`);
  return startService(["sh", "-c", `exec ${startCommand}`], { cwd: folder, env: settings, waitMs });
}

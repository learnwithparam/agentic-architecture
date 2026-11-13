// biome-ignore-all lint/style/useNamingConvention: environment variable names are in CONSTANT_CASE.
// Starts the finished platform against a running world: the model gateway and the services.
import { join } from "node:path";
import { startService } from "../world/proc";
import type { World } from "../world/services";

export async function startPlatform(world: World, journalDb: string) {
  const settings = { ...world.env, JOURNAL_DB: journalDb };
  const options = { cwd: import.meta.dir, env: settings };
  const gateway = await startService(["bun", join(import.meta.dir, "gateway.ts")], options);
  const services = await startService(["bun", join(import.meta.dir, "services.ts")], options);
  return {
    env: { GATEWAY_URL: gateway.url, PLATFORM_URL: services.url },
    async stop() {
      await gateway.stop();
      await services.stop();
    },
  };
}

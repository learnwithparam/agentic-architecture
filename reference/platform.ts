// Starts the finished platform against a running world: the model gateway and the platform services.
import { join } from "node:path";
import { startService } from "../world/proc";
import type { World } from "../world/services";

export async function startPlatform(world: World, journalDb: string) {
  const env = { ...world.env, JOURNAL_DB: journalDb };
  const gateway = await startService(["bun", join(import.meta.dir, "gateway.ts")], {
    cwd: import.meta.dir,
    env,
  });
  const services = await startService(["bun", join(import.meta.dir, "services.ts")], {
    cwd: import.meta.dir,
    env,
  });
  return {
    env: { GATEWAY_URL: gateway.url, PLATFORM_URL: services.url },
    async stop() {
      await gateway.stop();
      await services.stop();
    },
  };
}

// bun run after: reset the world, run the same open queue on the finished platform, print the report card.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { data } from "../world/db";
import { card, costs, printCard } from "../world/report";
import { brokerDesk, runAgent } from "../world/scenario";
import { startWorld, type World } from "../world/services";
import { startPlatform } from "./platform";

export async function runAfter(world: World, stateDir: string) {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const platform = await startPlatform(world, join(stateDir, "platform.db"));
  try {
    const teams = join(import.meta.dir, "..", "teams");
    const agent = async (team: string) => {
      const t = data<any[]>("teams").find((x) => x.team === team);
      const env = {
        ...platform.env,
        AGENT: t.agent,
        TEAM_KEY: t.key,
        RUN_ID: `${team}-run-1`,
        STATE_DIR: stateDir,
        CRASH_AFTER: "pay_exam_fee",
      };
      await runAgent(join(teams, `${team}.ts`), env);
    };
    await agent("classification");
    await brokerDesk(world);
    await agent("paperwork");
    await agent("holds");
  } finally {
    await platform.stop();
  }
}

if (import.meta.main) {
  const world = await startWorld({ reset: true });
  try {
    await runAfter(world, join(import.meta.dir, "..", "world", "state", "after"));
    printCard(
      "Harbourgate on the platform:",
      card(world.db, join(import.meta.dir, "..", "teams")),
      costs(world.db),
    );
  } finally {
    world.stop();
  }
}

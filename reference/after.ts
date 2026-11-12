// biome-ignore-all lint/style/useNamingConvention: environment variable names are in CONSTANT_CASE.
// bun run after: reset the world, run the same open queue on the finished platform,
// and print the report card.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { data } from "../world/db";
import { card, costs, printCard } from "../world/report";
import { brokerDesk, runAgent } from "../world/scenario";
import { startWorld, type World } from "../world/services";
import { startPlatform } from "./platform";

type Team = { team: string; agent: string; key: string };

const TEAMS_FOLDER = join(import.meta.dir, "..", "teams");

function teamNamed(name: string): Team {
  const team = data<Team[]>("teams").find((candidate) => candidate.team === name);
  if (!team) throw new Error(`world/data/teams.json has no team called ${name}.`);
  return team;
}

export async function runAfter(world: World, stateDir: string) {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const platform = await startPlatform(world, join(stateDir, "platform.db"));
  // Each team's agent runs with only its own identity and the platform's addresses.
  const runTeamAgent = async (name: string) => {
    const team = teamNamed(name);
    const settings = {
      ...platform.env,
      AGENT: team.agent,
      TEAM_KEY: team.key,
      RUN_ID: `${name}-run-1`,
      STATE_DIR: stateDir,
      CRASH_AFTER: "pay_exam_fee",
    };
    await runAgent(join(TEAMS_FOLDER, `${name}.ts`), settings);
  };
  try {
    await runTeamAgent("classification");
    await brokerDesk(world);
    await runTeamAgent("paperwork");
    await runTeamAgent("holds");
  } finally {
    await platform.stop();
  }
}

if (import.meta.main) {
  const world = await startWorld({ reset: true });
  try {
    await runAfter(world, join(import.meta.dir, "..", "world", "state", "after"));
    const reportCard = card(world.db, TEAMS_FOLDER);
    printCard("Harbourgate on the platform:", reportCard, costs(world.db));
  } finally {
    world.stop();
  }
}

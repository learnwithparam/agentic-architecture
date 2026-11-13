// biome-ignore-all lint/style/useNamingConvention: settings like GATEWAY_URL are in capitals.
// One layer is swapped for a product, and the contracts still hold: every check of that layer
// passes on the swapped platform, the team agents in teams/ run on it unchanged with a clean
// report card, and decisions/swap.md says what was gained and what was lost.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findStep } from "../scripts/structure";
import type { Rule } from "../scripts/verify";
import { data } from "../world/db";
import { startService } from "../world/proc";
import { type Card, card } from "../world/report";
import { brokerDesk } from "../world/scenario";
import type { World } from "../world/services";
import { gatewayEnv } from "./lib/gateway";
import { platformToml, startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, freshWorld, ROOT } from "./lib/world";

// The nine layers of the platform, and the checks that prove each one.
export const LAYERS: Record<string, string[]> = {
  "model-gateway": ["route-calls-through-gateway", "fall-back-on-outage", "cap-spend-per-importer"],
  "tool-policy": ["register-approved-tools", "deny-the-planted-call", "require-broker-signoff"],
  "agent-identity": ["issue-agent-identities", "exchange-tokens-per-call"],
  tenancy: ["isolate-importer-data"],
  memory: ["scope-memory-per-importer"],
  "run-shapes": ["run-both-shapes"],
  "durable-runs": ["resume-a-killed-run", "release-the-container-once"],
  "traces-and-cost": ["trace-one-entry", "split-cost-by-importer"],
  "release-gate": ["block-a-bad-release"],
};

type Team = { team: string; agent: string; key: string };
type RuleOfAStep = { says: string; test: (folder: string) => boolean | Promise<boolean> };

const TEAMS_FOLDER = join(ROOT, "teams");
const STARTER_TEAMS = join(ROOT, "parts", "01-route-model-calls", "03-cap-spend-per-importer");
const KILLED = 137;

export function swapOf(folder: string): { layer: string; product: string } {
  const swap = platformToml(folder).swap ?? {};
  return { layer: String(swap.layer ?? ""), product: String(swap.product ?? "") };
}

// The checks of a layer that exist in this repo. A part not built yet has none.
export function builtChecksOf(layer: string): string[] {
  return (LAYERS[layer] ?? []).filter((stepName) => findStep(stepName) !== undefined);
}

// Every rule of every named check, run on this folder. Returns the rules that failed.
export async function failingRules(stepNames: string[], folder: string): Promise<string[]> {
  const failed: string[] = [];
  for (const stepName of stepNames) {
    const rules: RuleOfAStep[] = (await import(`./${stepName}.ts`)).default;
    for (const rule of rules) {
      const holds = await Promise.resolve(rule.test(folder)).catch(() => false);
      if (!holds) failed.push(`${stepName}: ${rule.says}`);
    }
  }
  return failed;
}

// Run one team agent quietly. A worker killed on purpose (exit 137) is restarted once.
export async function runTeamAgent(file: string, settings: Record<string, string>) {
  for (let attempt = 0; attempt <= 1; attempt++) {
    const agent = Bun.spawn(["bun", file], {
      env: { ...process.env, ...settings },
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await agent.exited;
    if (exitCode !== KILLED) return exitCode === 0;
  }
  return false;
}

export async function startPlatformServices(world: World, folder: string, extra = {}) {
  // A fresh journal, so no step looks done from an earlier run.
  const journal = join(ROOT, "world", "state", `check-journal-${crypto.randomUUID()}.db`);
  const settings = { ...world.env, JOURNAL_DB: journal };
  const ownServices = platformToml(folder).services?.start;
  if (ownServices) return startLearner(folder, "services", { ...settings, ...extra });
  const referenceServices = ["bun", join(ROOT, "reference", "services.ts")];
  return startService(referenceServices, { cwd: join(ROOT, "reference"), env: settings });
}

function teamNamed(name: string): Team {
  const team = data<Team[]>("teams").find((candidate) => candidate.team === name);
  if (!team) throw new Error(`world/data/teams.json has no team called ${name}`);
  return team;
}

export type QueueRun = { agentsFinished: boolean; card: Card; teamsBilled: string[] };

// The open queue, the way bun run after runs it, but on the learner's gateway.
export async function runTheQueue(world: World, urls: Record<string, string>): Promise<QueueRun> {
  const stateFolder = join(ROOT, "world", "state", "check-queue");
  rmSync(stateFolder, { recursive: true, force: true });
  mkdirSync(stateFolder, { recursive: true });
  const settingsFor = (name: string) => ({
    ...urls,
    AGENT: teamNamed(name).agent,
    TEAM_KEY: teamNamed(name).key,
    RUN_ID: `${name}-run-1`,
    STATE_DIR: stateFolder,
    CRASH_AFTER: "pay_exam_fee",
  });
  const finished = [
    await runTeamAgent(join(TEAMS_FOLDER, "classification.ts"), settingsFor("classification")),
  ];
  await brokerDesk(world);
  finished.push(await runTeamAgent(join(TEAMS_FOLDER, "paperwork.ts"), settingsFor("paperwork")));
  finished.push(await runTeamAgent(join(TEAMS_FOLDER, "holds.ts"), settingsFor("holds")));
  const billed = allRows<{ team: string }>(world, "SELECT DISTINCT team FROM spend_log");
  return {
    agentsFinished: finished.every(Boolean),
    card: card(world.db, TEAMS_FOLDER),
    teamsBilled: billed.map((row) => row.team),
  };
}

async function scenario(folder: string) {
  const layer = swapOf(folder).layer;
  const failed = await failingRules(builtChecksOf(layer), folder);
  const world = await freshWorld();
  try {
    const gateway = await startLearner(folder, "gateway", gatewayEnv(world.env));
    const services = await startPlatformServices(world, folder);
    try {
      const urls = { GATEWAY_URL: gateway.url, PLATFORM_URL: services.url };
      return { failed, queue: await runTheQueue(world, urls) };
    } finally {
      await gateway.stop();
      await services.stop();
    }
  } finally {
    world.stop();
  }
}

function run(folder: string) {
  return once("swap-one-layer", folder, scenario);
}

function filesIn(folder: string): Record<string, string> {
  if (!existsSync(folder)) return {};
  const names = readdirSync(folder, { recursive: true }) as string[];
  const files = names.filter((name) => name.endsWith(".ts"));
  return Object.fromEntries(files.map((name) => [name, readFileSync(join(folder, name), "utf8")]));
}

function teamsUnchanged(folder: string): boolean {
  const yours = filesIn(join(folder, "teams"));
  const before = filesIn(join(STARTER_TEAMS, "solution", "teams"));
  const sameAsBefore = JSON.stringify(yours) === JSON.stringify(before);
  const rootDiff = Bun.spawnSync(["git", "diff", "--quiet", "HEAD", "--", "teams"], { cwd: ROOT });
  return sameAsBefore && rootDiff.exitCode === 0;
}

const SECTIONS = [
  "What we swapped",
  "What stays the same",
  "What we gained",
  "What we lost",
  "How we would undo it",
];

// The text under one "## heading" of decisions/swap.md, without HTML comments.
export function sectionText(markdown: string, heading: string): string {
  const afterHeading = markdown.split(`## ${heading}`)[1] ?? "";
  const section = afterHeading.split(/\n## /)[0];
  return section.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function decisionFile(folder: string): string {
  const file = join(folder, "decisions", "swap.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

const NOTHING_LOST = /^(-\s*)?(nothing|none|no loss(es)?|n\/a)\.?$/i;

export default [
  {
    says: "platform.toml names the swapped layer and the product under [swap]",
    test: (folder) => {
      const swap = swapOf(folder);
      return swap.layer in LAYERS && swap.product.trim().length > 2;
    },
    tryNext: `under [swap] set layer to one of ${Object.keys(LAYERS).join(", ")}, and product`,
  },
  {
    says: "the checks of the swapped layer exist in this repo",
    test: (folder) => builtChecksOf(swapOf(folder).layer).length > 0,
    tryNext: "swap a layer whose part is built in this repo, such as model-gateway",
  },
  {
    says: "every check of the swapped layer still passes on your swapped platform",
    test: async (folder) => {
      const layerChecks = builtChecksOf(swapOf(folder).layer);
      return layerChecks.length > 0 && (await run(folder)).failed?.length === 0;
    },
    tryNext: "keep the contract in your adapter: 401, 402, one spend row per call, failed tries",
  },
  {
    says: "the team agents in teams/ run on the swapped platform with a clean report card",
    test: async (folder) => {
      const { queue } = await run(folder);
      if (!queue) return false;
      const everyCountIsZero = Object.values(queue.card).every((count) => count === 0);
      const everyTeamBilled = ["classification", "paperwork", "holds"].every((team) =>
        queue.teamsBilled.includes(team),
      );
      return queue.agentsFinished && everyCountIsZero && everyTeamBilled;
    },
    tryNext: "the teams send their team key and x-importer; your adapter must accept exactly that",
  },
  {
    says: "nothing under teams/ changed",
    test: teamsUnchanged,
    tryNext: "undo every change under teams/; a swap changes platform.toml and adapters only",
  },
  {
    says: "decisions/swap.md fills every section",
    test: (folder) => {
      const markdown = decisionFile(folder);
      return SECTIONS.every((heading) => sectionText(markdown, heading).length > 20);
    },
    tryNext: `write a few lines under each heading: ${SECTIONS.join(", ")}`,
  },
  {
    says: "decisions/swap.md names at least one thing you lost",
    test: (folder) => {
      const lost = sectionText(decisionFile(folder), "What we lost");
      return lost.length > 20 && !NOTHING_LOST.test(lost);
    },
    tryNext: "every swap costs something: name one thing you can no longer see, test or change",
  },
] satisfies Rule[];

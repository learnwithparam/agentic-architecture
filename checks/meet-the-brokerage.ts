// Orientation: the learner ran the "before" report card, read it, and recorded what they saw.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS } from "../config/models";
import type { Rule } from "../scripts/verify";
import { type Card, card } from "../world/report";
import { runBefore } from "../world/scenario";
import { platformToml } from "./lib/learner";
import { freshWorld, numberFrom, ROOT } from "./lib/world";

type WorldTruth = { open: number; card: Card };

// The real numbers, worked out once from a fresh world and shared by every rule.
let worldTruthOnce: Promise<WorldTruth> | null = null;

async function measureWorld(): Promise<WorldTruth> {
  const world = await freshWorld();
  try {
    const open = numberFrom(world, "SELECT COUNT(*) AS total FROM shipments WHERE status = 'open'");
    await runBefore(world, join(ROOT, "world", "state", "check-before"));
    return { open, card: card(world.db, join(ROOT, "world", "legacy")) };
  } finally {
    world.stop();
  }
}

function worldTruth(): Promise<WorldTruth> {
  worldTruthOnce ??= measureWorld();
  return worldTruthOnce;
}

function recordedNumber(folder: string, name: keyof Card): number {
  const before = platformToml(folder).before;
  return Number(before?.[name]);
}

// A rule test: the number the learner wrote down equals the number the world really shows.
function matches(name: keyof Card) {
  return async (folder: string) => {
    const truth = await worldTruth();
    return recordedNumber(folder, name) === truth.card[name];
  };
}

function learnerValue(folder: string, name: string): unknown {
  return platformToml(folder).learner?.[name];
}

export default [
  {
    says: "the world starts and its open queue has 12 shipments",
    test: async () => (await worldTruth()).open === 12,
    tryNext: "run bun run world reset, then bun run world, and read troubleshooting.md if it fails",
  },
  {
    says: "platform.toml exists in your folder",
    test: (folder) => existsSync(join(folder, "platform.toml")),
    tryNext: "create platform.toml in this step's problem folder from the starter",
  },
  {
    says: "platform.toml names you under [learner]",
    test: (folder) => {
      const name = String(learnerValue(folder, "name") ?? "");
      return name.trim().length > 1;
    },
    tryNext: 'set name = "Your Name" under [learner]',
  },
  {
    says: "run_mode is one of replay, anthropic, openrouter, openai, ollama",
    test: (folder) => {
      const runMode = learnerValue(folder, "run_mode");
      return (PROVIDERS as readonly unknown[]).includes(runMode);
    },
    tryNext: 'set run_mode = "replay" unless you added a key to .env',
  },
  {
    says: "you recorded how many model calls bypassed the gateway",
    test: matches("calls_outside_gateway"),
    tryNext: "run bun run before and copy the first number into calls_outside_gateway",
  },
  {
    says: "you recorded how many provider keys sit in team code",
    test: matches("provider_keys_in_team_code"),
    tryNext: "copy the provider keys line from bun run before into provider_keys_in_team_code",
  },
  {
    says: "you recorded how many tool calls had no identity",
    test: matches("tool_calls_with_no_identity"),
    tryNext: "copy the tool calls line from bun run before into tool_calls_with_no_identity",
  },
  {
    says: "you recorded how many documents were read across importers",
    test: matches("cross_importer_reads"),
    tryNext: "copy the documents line from bun run before into cross_importer_reads",
  },
  {
    says: "you recorded how many entries were filed with no broker signature",
    test: matches("entries_with_no_broker_signature"),
    tryNext: "copy the entries line from bun run before into entries_with_no_broker_signature",
  },
  {
    says: "you recorded how many exam fees were paid twice",
    test: matches("exam_fees_paid_twice"),
    tryNext: "copy the exam fees line from bun run before into exam_fees_paid_twice",
  },
] satisfies Rule[];

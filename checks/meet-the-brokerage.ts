// Orientation: the learner ran the "before" report card, read it, and recorded what they saw.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS } from "../config/models";
import type { Rule } from "../scripts/verify";
import { type Card, card } from "../world/report";
import { runBefore } from "../world/scenario";
import { platformToml } from "./lib/learner";
import { freshWorld, one, ROOT } from "./lib/world";

let truth: Promise<{ open: number; card: Card }> | null = null;
const worldTruth = () =>
  (truth ??= (async () => {
    const w = await freshWorld();
    try {
      const open = one(w, "SELECT COUNT(*) AS n FROM shipments WHERE status = 'open'").n;
      await runBefore(w, join(ROOT, "world", "state", "check-before"));
      return { open, card: card(w.db, join(ROOT, "world", "legacy")) };
    } finally {
      w.stop();
    }
  })());

const field = (dir: string, k: keyof Card) => Number(platformToml(dir).before?.[k]);
const matches = (k: keyof Card) => async (dir: string) =>
  field(dir, k) === (await worldTruth()).card[k];

export default [
  {
    says: "the world starts and its open queue has 12 shipments",
    test: async () => (await worldTruth()).open === 12,
    tryNext: "run bun run world reset, then bun run world, and read troubleshooting.md if it fails",
  },
  {
    says: "platform.toml exists in your folder",
    test: (d) => existsSync(join(d, "platform.toml")),
    tryNext: "create platform.toml in this step's problem folder from the starter",
  },
  {
    says: "platform.toml names you under [learner]",
    test: (d) => String(platformToml(d).learner?.name ?? "").trim().length > 1,
    tryNext: 'set name = "Your Name" under [learner]',
  },
  {
    says: "run_mode is one of replay, anthropic, openrouter, openai, ollama",
    test: (d) => (PROVIDERS as readonly string[]).includes(platformToml(d).learner?.run_mode),
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

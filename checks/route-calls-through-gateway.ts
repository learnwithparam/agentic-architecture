// The gateway lets in only team keys, calls providers with the platform's key, and logs spend that
// matches the providers' own bill. The check starts your gateway and reads the world, not the replies.
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { keysIn } from "../world/report";
import { chat, gatewayEnv, keyOf, type Reply } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { freshWorld, rows, one } from "./lib/world";

const CALLS = [
  { team: "classification", importer: "fjordline", role: "smart" },
  { team: "paperwork", importer: "ridgeway", role: "fast" },
  { team: "holds", importer: "northpoint", role: "fast" },
  { team: "paperwork", importer: "northpoint", role: "judge" },
  { team: "classification", importer: "ridgeway", role: "smart" },
];

async function scenario(dir: string) {
  const w = await freshWorld();
  try {
    const gw = await startLearner(dir, "gateway", gatewayEnv(w.env));
    try {
      const noKey = await chat(gw.url, { importer: "fjordline", task: "ping:1" });
      const badKey = await chat(gw.url, { key: "hgk_nobody_000000", importer: "fjordline", task: "ping:1" });
      const answered: Reply[] = [];
      for (const [i, c] of CALLS.entries()) answered.push(await chat(gw.url, { key: keyOf(c.team), importer: c.importer, role: c.role, task: `ping:${i + 1}` }));
      await Bun.sleep(100);
      return {
        up: true, noKey: noKey.status, badKey: badKey.status, answered: answered.map((a) => a.status),
        keyOwners: rows(w, "SELECT DISTINCT key_owner FROM provider_calls").map((r) => r.key_owner),
        spend: rows(w, "SELECT * FROM spend_log WHERE status = 'ok'"),
        spendTotal: one(w, "SELECT COALESCE(SUM(cost_micros),0) AS c FROM spend_log").c,
        billed: one(w, "SELECT COALESCE(SUM(cost_micros),0) AS c FROM provider_calls").c,
        billedCalls: one(w, "SELECT COUNT(*) AS n FROM provider_calls WHERE status = 200").n,
      };
    } finally { await gw.stop(); }
  } finally { w.stop(); }
}

const run = (dir: string) => once("route-calls-through-gateway", dir, scenario) as Promise<any>;
const spendRowsComplete = (r: any) =>
  r.spend.length === CALLS.length && r.billedCalls === CALLS.length &&
  CALLS.every((c) => r.spend.some((s: any) => s.team === c.team && s.importer === c.importer && s.role === c.role && s.tokens_in > 0 && s.tokens_out > 0));

export default [
  { says: "your gateway starts from platform.toml and answers GET /health", test: async (d) => (await run(d)).up === true, tryNext: "run bun gateway.ts in your folder and fix any error it prints; it must listen on PORT" },
  { says: "a call with no team key is refused with 401", test: async (d) => (await run(d)).noKey === 401, tryNext: "read the Authorization header and return 401 when it is missing" },
  { says: "a call with an unknown key is refused with 401", test: async (d) => (await run(d)).badKey === 401, tryNext: "look the key up in TEAMS_FILE and return 401 when no team has it" },
  { says: "a call with each team's key is answered (200)", test: async (d) => (await run(d)).answered?.every((s: number) => s === 200), tryNext: "forward the call to PROVIDER_A_URL and return its answer; check the provider got a key it knows" },
  { says: "the provider only ever saw the platform's key, never a team's", test: async (d) => { const r = await run(d); return r.billedCalls > 0 && r.keyOwners?.every((k: string) => k === "platform"); }, tryNext: "send Authorization: Bearer PROVIDER_A_KEY to the provider, not the caller's header" },
  { says: "every answered call wrote one spend row with team, importer, role and tokens", test: async (d) => spendRowsComplete(await run(d)), tryNext: "POST one row per call to LEDGER_URL/spend with team, importer, role, tokens_in and tokens_out" },
  { says: "the spend log adds up to the providers' bill, to the micro-dollar", test: async (d) => { const r = await run(d); return r.billed > 0 && r.spendTotal === r.billed; }, tryNext: "price each call from the usage the provider returned and the prices in PROVIDERS_FILE" },
  { says: "teams/ holds no provider key", test: (d) => keysIn(join(d, "teams")) === 0, tryNext: "remove the pk- key from teams/paperwork.ts and send process.env.TEAM_KEY to the gateway" },
] satisfies Rule[];

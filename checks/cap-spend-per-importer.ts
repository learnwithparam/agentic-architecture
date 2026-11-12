// Ridgeway's seasonal burst stops at its budget with a plain 402, nobody else is cut off, no call is
// quietly moved to a cheaper model, and a team budget holds too.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { chat, gatewayEnv, keyOf } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { DATA, freshWorld, one, ROOT, rows } from "./lib/world";

const BUDGETS = require(join(DATA, "budgets.json"));
const LIMIT = BUDGETS.importers.ridgeway;

async function scenario(dir: string) {
  const w = await freshWorld();
  // Finance's budgets, plus a small limit on the Holds team so the team budget is tested too.
  const file = join(ROOT, "world", "state", "check-budgets.json");
  mkdirSync(join(ROOT, "world", "state"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ importers: BUDGETS.importers, teams: { ...BUDGETS.teams, holds: 3000 } }),
  );
  try {
    const gw = await startLearner(dir, "gateway", gatewayEnv(w.env, { BUDGETS_FILE: file }));
    try {
      const burst = [];
      for (let i = 1; i <= 40; i++)
        burst.push(
          await chat(gw.url, {
            key: keyOf("paperwork"),
            importer: "ridgeway",
            role: "smart",
            task: `ping:${i}`,
            pad: 100,
          }),
        );
      const fjordline = [];
      for (let i = 1; i <= 3; i++)
        fjordline.push(
          await chat(gw.url, {
            key: keyOf("classification"),
            importer: "fjordline",
            role: "smart",
            task: `ping:${i}`,
          }),
        );
      const holds = [];
      for (let i = 1; i <= 8; i++)
        holds.push(
          await chat(gw.url, {
            key: keyOf("holds"),
            importer: "northpoint",
            role: "smart",
            task: `ping:${i}`,
            pad: 100,
          }),
        );
      await Bun.sleep(100);
      const ridge = rows(
        w,
        "SELECT cost_micros, role FROM spend_log WHERE importer = 'ridgeway' AND status = 'ok'",
      );
      return {
        burst: burst.map((b) => ({
          status: b.status,
          message: String(b.body?.error?.message ?? ""),
        })),
        fjordline: fjordline.map((b) => b.status),
        holds: holds.map((b) => b.status),
        ridgeSpend: ridge.reduce((a, r) => a + r.cost_micros, 0),
        ridgeMax: Math.max(0, ...ridge.map((r) => r.cost_micros)),
        roles: [
          ...new Set(
            rows(w, "SELECT role FROM provider_calls WHERE status = 200").map((r) => r.role),
          ),
        ],
        spendTotal: one(w, "SELECT COALESCE(SUM(cost_micros),0) AS c FROM spend_log").c,
        billed: one(w, "SELECT COALESCE(SUM(cost_micros),0) AS c FROM provider_calls").c,
      };
    } finally {
      await gw.stop();
    }
  } finally {
    w.stop();
  }
}
const run = (dir: string) => once("cap-spend-per-importer", dir, scenario) as Promise<any>;
const firstRefusal = (r: any) => r.burst?.findIndex((b: any) => b.status === 402) ?? -1;

export default [
  {
    says: "Ridgeway's burst is answered until its budget, then refused with 402 every time",
    test: async (d) => {
      const r = await run(d);
      const i = firstRefusal(r);
      return (
        i > 0 &&
        r.burst.slice(0, i).every((b: any) => b.status === 200) &&
        r.burst.slice(i).every((b: any) => b.status === 402)
      );
    },
    tryNext:
      "keep a running total per importer and return 402 before calling a provider once it reaches BUDGETS_FILE's limit",
  },
  {
    says: "the 402 says, in plain words, which importer's budget was reached",
    test: async (d) => {
      const r = await run(d);
      const i = firstRefusal(r);
      return i > 0 && /ridgeway/i.test(r.burst[i].message) && /budget/i.test(r.burst[i].message);
    },
    tryNext:
      'return { "error": { "message": "Budget reached for importer ridgeway ..." } } with the 402',
  },
  {
    says: "Ridgeway's spend stops within one call of its budget",
    test: async (d) => {
      const r = await run(d);
      return r.ridgeSpend > 0 && r.ridgeSpend - r.ridgeMax < LIMIT;
    },
    tryNext:
      "check the total before each call, not after; add each call's cost as soon as it is priced",
  },
  {
    says: "no call was quietly moved to a cheaper model",
    test: async (d) => {
      const r = await run(d);
      return r.roles?.length > 0 && r.roles.every((x: string) => x === "smart");
    },
    tryNext: "never change the role a team asked for; refuse with 402 instead",
  },
  {
    says: "Fjordline is still answered after Ridgeway is cut off",
    test: async (d) => (await run(d)).fjordline?.every((s: number) => s === 200),
    tryNext: "keep a separate total per importer so one importer's burst never blocks another",
  },
  {
    says: "a team over its own budget is refused with 402 too",
    test: async (d) => {
      const h = (await run(d)).holds ?? [];
      return h[0] === 200 && h.includes(402);
    },
    tryNext: "keep a running total per team as well and check BUDGETS_FILE's teams limits",
  },
  {
    says: "the spend log still adds up to the providers' bill",
    test: async (d) => {
      const r = await run(d);
      return r.billed > 0 && r.spendTotal === r.billed;
    },
    tryNext: "log every answered call once, priced from the provider's usage",
  },
] satisfies Rule[];

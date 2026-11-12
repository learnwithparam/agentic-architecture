// When provider A goes down, every call still gets an answer from provider B, the failed tries are
// on the record, and a route that would fall back to a weaker model never starts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { chat, gatewayEnv, keyOf } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { freshWorld, one, ROOT } from "./lib/world";

async function scenario(dir: string) {
  const w = await freshWorld();
  try {
    const gw = await startLearner(dir, "gateway", gatewayEnv(w.env));
    let up: any[] = [], down: any[] = [];
    try {
      for (let i = 1; i <= 3; i++) up.push(await chat(gw.url, { key: keyOf("holds"), importer: "ridgeway", role: "fast", task: `ping:${i}` }));
      w.providerA.state.down = true;
      for (let i = 1; i <= 10; i++) down.push(await chat(gw.url, { key: keyOf("holds"), importer: "ridgeway", role: i % 2 ? "fast" : "smart", task: `ping:${i}` }));
      await Bun.sleep(100);
    } finally { await gw.stop(); }
    // A route table that falls back from smart to fast. A safe gateway refuses to start on it.
    const bad = join(ROOT, "world", "state", "bad-routes.json");
    mkdirSync(join(ROOT, "world", "state"), { recursive: true });
    writeFileSync(bad, JSON.stringify({ "*": { fast: ["a:fast", "b:fast"], smart: ["a:smart", "b:fast"], judge: ["a:judge", "b:judge"] } }));
    let refused = false;
    try {
      const g2 = await startLearner(dir, "gateway", gatewayEnv(w.env, { ROUTES_FILE: bad }), 4000);
      await g2.stop();
    } catch { refused = true; }
    return {
      up, down, refused,
      errorRows: one(w, "SELECT COUNT(*) AS n FROM spend_log WHERE provider = 'a' AND status = 'provider_error'").n,
      spendTotal: one(w, "SELECT COALESCE(SUM(cost_micros),0) AS c FROM spend_log").c,
      billed: one(w, "SELECT COALESCE(SUM(cost_micros),0) AS c FROM provider_calls").c,
    };
  } finally { w.stop(); }
}
const run = (dir: string) => once("fall-back-on-outage", dir, scenario) as Promise<any>;

export default [
  { says: "with both providers up, calls go to provider a", test: async (d) => { const r = await run(d); return r.up?.length === 3 && r.up.every((x: any) => x.status === 200 && x.provider === "a"); }, tryNext: "try the hops in routes.json in order and set the x-gateway-provider header to the provider that answered" },
  { says: "with provider a down, all 10 calls are still answered (200)", test: async (d) => { const r = await run(d); return r.down?.length === 10 && r.down.every((x: any) => x.status === 200); }, tryNext: "when a provider fails, try the next hop in the route instead of returning an error" },
  { says: "each of those answers says x-gateway-provider: b", test: async (d) => (await run(d)).down?.every((x: any) => x.provider === "b"), tryNext: "set the x-gateway-provider header to the provider that actually answered" },
  { says: "each failed try on provider a is in the spend log as provider_error", test: async (d) => (await run(d)).errorRows >= 10, tryNext: "POST a spend row with status provider_error and cost 0 for every failed try" },
  { says: "the spend log still adds up to the providers' bill", test: async (d) => { const r = await run(d); return r.billed > 0 && r.spendTotal === r.billed; }, tryNext: "price each call with the prices of the provider that answered it, not provider a's" },
  { says: "a route that falls back to a weaker model is refused at start", test: async (d) => (await run(d)).refused === true, tryNext: "when you load routes.json, exit with an error if any hop is a lower tier than the role asked for" },
] satisfies Rule[];

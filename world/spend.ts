// bun run spend: the gateway's spend log from the last check run, by importer and team,
// next to what the providers billed. Reads world/state/check.db (or WORLD_DB).
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const path = process.env.WORLD_DB ?? join(import.meta.dir, "state", "check.db");
if (!existsSync(path)) {
  console.log("No check has run yet. Run bun run verify <step-name> first.");
  process.exit(1);
}
const db = new Database(path, { readonly: true });
const usd = (m: number) => `USD ${(m / 1e6).toFixed(6)}`;
console.log("Spend log, by importer and team:");
console.log("  importer     team             calls  errors  cost");
for (const r of db.query(`SELECT importer, team, SUM(status = 'ok') AS ok, SUM(status <> 'ok') AS errors, SUM(cost_micros) AS cost
  FROM spend_log GROUP BY importer, team ORDER BY importer, team`).all() as any[])
  console.log(`  ${String(r.importer).padEnd(12)} ${String(r.team).padEnd(16)} ${String(r.ok).padStart(5)}  ${String(r.errors).padStart(6)}  ${usd(r.cost)}`);
const spend = (db.query("SELECT COALESCE(SUM(cost_micros),0) AS c FROM spend_log").get() as any).c;
const billed = (db.query("SELECT COALESCE(SUM(cost_micros),0) AS c FROM provider_calls").get() as any).c;
console.log(`Gateway spend ${usd(spend)}. Providers billed ${usd(billed)}. ${spend === billed ? "They match." : "They do not match."}`);

// bun run spend: the gateway's spend log from the last check run, by importer and team,
// next to what the providers billed. Reads world/state/check.db (or WORLD_DB).
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

type SpendGroup = {
  importer: string;
  team: string;
  answered: number;
  errors: number;
  cost: number;
};

const path = process.env.WORLD_DB ?? join(import.meta.dir, "state", "check.db");
if (!existsSync(path)) {
  console.log("No check has run yet. Run bun run verify <step-name> first.");
  process.exit(1);
}
const db = new Database(path, { readonly: true });

// Costs are stored in micro-dollars: 1000000 is one US dollar.
function inDollars(micros: number): string {
  return `USD ${(micros / 1e6).toFixed(6)}`;
}

function totalCost(table: string): number {
  const row = db.query(`SELECT COALESCE(SUM(cost_micros),0) AS total FROM ${table}`).get();
  return (row as { total: number }).total;
}

const SPEND_BY_IMPORTER_AND_TEAM = `
  SELECT importer, team, SUM(status = 'ok') AS answered, SUM(status <> 'ok') AS errors,
    SUM(cost_micros) AS cost
  FROM spend_log GROUP BY importer, team ORDER BY importer, team`;

function groupLine(group: SpendGroup): string {
  const importer = String(group.importer).padEnd(12);
  const team = String(group.team).padEnd(16);
  const answered = String(group.answered).padStart(5);
  const errors = String(group.errors).padStart(6);
  return `  ${importer} ${team} ${answered}  ${errors}  ${inDollars(group.cost)}`;
}

console.log("Spend log, by importer and team:");
console.log("  importer     team             calls  errors  cost");
for (const group of db.query(SPEND_BY_IMPORTER_AND_TEAM).all() as SpendGroup[]) {
  console.log(groupLine(group));
}
const spent = totalCost("spend_log");
const billed = totalCost("provider_calls");
const verdict = spent === billed ? "They match." : "They do not match.";
console.log(`Gateway spend ${inDollars(spent)}. Providers billed ${inDollars(billed)}. ${verdict}`);

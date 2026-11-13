// biome-ignore-all lint/style/useNamingConvention: the JSON report uses snake_case fields.
// bun costs.ts         the cost per released entry for each importer, as a table
// bun costs.ts --json  the same numbers as JSON, for the check
// Reads the system of record: the gateway's spend log, the entries, and the providers' bill.
import { Database } from "bun:sqlite";
import { join } from "node:path";

type ImporterCost = {
  importer: string;
  spend_micros: number;
  released: number;
  cost_per_entry_micros: number | null;
};

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const databasePath = process.env.WORLD_DB ?? join(ROOT, "world", "state", "check.db");
const db = new Database(databasePath, { readonly: true });

function total(sql: string): number {
  const row = db.query(sql).get() as { total: number };
  return row.total;
}

const SPEND_AND_RELEASED = `
  SELECT i.id AS importer,
    (SELECT COALESCE(SUM(cost_micros),0) FROM spend_log WHERE importer = i.id) AS spend_micros,
    (SELECT COUNT(*) FROM entries e JOIN shipments s ON s.id = e.shipment
      WHERE s.importer = i.id AND e.status = 'released') AS released
  FROM importers i ORDER BY i.id`;

function importerCosts(): ImporterCost[] {
  const rows = db.query(SPEND_AND_RELEASED).all() as Omit<ImporterCost, "cost_per_entry_micros">[];
  return rows.map((row) => {
    let costPerEntry: number | null = null;
    if (row.released > 0) costPerEntry = Math.round(row.spend_micros / row.released);
    return { ...row, cost_per_entry_micros: costPerEntry };
  });
}

const importers = importerCosts();
// Rows with no importer belong to nobody, so they are left out.
const unattributed = 0;
const importerTotal = importers.reduce((sum, cost) => sum + cost.spend_micros, 0);
const report = {
  importers,
  unattributed_micros: unattributed,
  total_micros: importerTotal + unattributed,
  billed_micros: total("SELECT COALESCE(SUM(cost_micros),0) AS total FROM provider_calls"),
};

// Costs are stored in micro-dollars: 1000000 is one US dollar.
const inDollars = (micros: number) => `USD ${(micros / 1e6).toFixed(6)}`;

function printTable(): void {
  console.log("Cost per released entry, by importer:");
  for (const cost of importers) {
    let perEntry = "no entry released";
    if (cost.cost_per_entry_micros !== null) perEntry = inDollars(cost.cost_per_entry_micros);
    const name = cost.importer.padEnd(11);
    console.log(
      `  ${name} ${inDollars(cost.spend_micros)}  ${cost.released} released  ${perEntry}`,
    );
  }
  console.log(`  ${"unattributed".padEnd(11)} ${inDollars(report.unattributed_micros)}`);
  const verdict = report.total_micros === report.billed_micros ? "They match." : "They differ.";
  const billed = inDollars(report.billed_micros);
  console.log(`Total ${inDollars(report.total_micros)}. Providers billed ${billed}. ${verdict}`);
}

if (process.argv.includes("--json")) console.log(JSON.stringify(report));
else printTable();

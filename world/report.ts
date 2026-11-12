// biome-ignore-all lint/style/useNamingConvention: the card's fields match platform.toml.
// The report card. It reads the system of record and the team code, never what an agent said.
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Card = {
  calls_outside_gateway: number;
  provider_keys_in_team_code: number;
  tool_calls_with_no_identity: number;
  cross_importer_reads: number;
  entries_with_no_broker_signature: number;
  exam_fees_paid_twice: number;
};

export const LABELS: Record<keyof Card, string> = {
  calls_outside_gateway: "model calls that bypassed the gateway",
  provider_keys_in_team_code: "provider keys found in team code",
  tool_calls_with_no_identity: "tool calls with no record of who asked",
  cross_importer_reads: "documents read across importers",
  entries_with_no_broker_signature: "entries filed with no broker signature",
  exam_fees_paid_twice: "exam fees paid twice after a crash",
};

// Runs a query that counts something and returns its "n" column as a number.
function countOf(db: Database, sql: string): number {
  const row = db.query(sql).get() as { n: number };
  return Number(row.n);
}

const CODE_FILE = /\.(ts|js|py|json|env)$/;
const PROVIDER_KEY = /\bpk-[a-z]-[a-z0-9-]+/g;

// Counts the different provider keys (they start with "pk-") pasted into a folder of code.
export function keysIn(folder: string): number {
  const keysFound = new Set<string>();
  const files = readdirSync(folder, { recursive: true }) as string[];
  for (const file of files) {
    if (!CODE_FILE.test(file)) continue;
    const text = readFileSync(join(folder, file), "utf8");
    for (const match of text.matchAll(PROVIDER_KEY)) keysFound.add(match[0]);
  }
  return keysFound.size;
}

const FEES_PAID_TWICE = `
  SELECT COALESCE(SUM(c - 1), 0) AS n FROM (
    SELECT COUNT(*) AS c FROM payments WHERE purpose = 'exam_fee'
    GROUP BY shipment HAVING c > 1
  )`;

export function card(db: Database, teamCodeFolder: string): Card {
  return {
    calls_outside_gateway: countOf(
      db,
      "SELECT COUNT(*) AS n FROM provider_calls WHERE key_owner LIKE 'team:%'",
    ),
    provider_keys_in_team_code: keysIn(teamCodeFolder),
    tool_calls_with_no_identity: countOf(
      db,
      "SELECT COUNT(*) AS n FROM tool_audit WHERE agent IS NULL",
    ),
    cross_importer_reads: countOf(
      db,
      "SELECT COUNT(*) AS n FROM reads WHERE doc_importer <> for_importer",
    ),
    entries_with_no_broker_signature: countOf(
      db,
      "SELECT COUNT(DISTINCT entry) AS n FROM entry_lines WHERE signed_by IS NULL",
    ),
    exam_fees_paid_twice: countOf(db, FEES_PAID_TWICE),
  };
}

type ImporterCost = { importer: string; spend_micros: number; released: number };

const COST_PER_IMPORTER = `
  SELECT i.id AS importer,
    (SELECT COALESCE(SUM(cost_micros),0) FROM spend_log WHERE importer = i.id) AS spend_micros,
    (SELECT COUNT(*) FROM entries e JOIN shipments s ON s.id = e.shipment
      WHERE s.importer = i.id AND e.status = 'released') AS released
  FROM importers i ORDER BY i.id`;

// Cost per released entry for each importer, from the gateway's spend log.
export function costs(db: Database): ImporterCost[] {
  return db.query(COST_PER_IMPORTER).all() as ImporterCost[];
}

function costPerEntryLine(cost: ImporterCost): string {
  let perEntry = "no entry released yet";
  if (cost.released) {
    const dollars = cost.spend_micros / cost.released / 1e6;
    perEntry = `USD ${dollars.toFixed(4)}`;
  }
  return `    ${cost.importer.padEnd(11)} ${perEntry}  (${cost.released} released)`;
}

export function printCard(title: string, reportCard: Card, importerCosts?: ImporterCost[]) {
  console.log(title);
  for (const [field, label] of Object.entries(LABELS)) {
    const count = String(reportCard[field as keyof Card]);
    console.log(`  ${count.padStart(4)}  ${label}`);
  }
  if (!importerCosts) {
    console.log("  Cost per released entry: unknown, no call records which importer it was for");
    return;
  }
  console.log("  Cost per released entry:");
  for (const cost of importerCosts) console.log(costPerEntryLine(cost));
}

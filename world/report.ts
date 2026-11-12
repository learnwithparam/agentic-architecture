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

const n = (db: Database, sql: string) => Number((db.query(sql).get() as any).n);

export function keysIn(dir: string): number {
  const found = new Set<string>();
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    if (!/\.(ts|js|py|json|env)$/.test(f)) continue;
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/\bpk-[a-z]-[a-z0-9-]+/g))
      found.add(m[0]);
  }
  return found.size;
}

export function card(db: Database, teamCodeDir: string): Card {
  return {
    calls_outside_gateway: n(
      db,
      "SELECT COUNT(*) AS n FROM provider_calls WHERE key_owner LIKE 'team:%'",
    ),
    provider_keys_in_team_code: keysIn(teamCodeDir),
    tool_calls_with_no_identity: n(db, "SELECT COUNT(*) AS n FROM tool_audit WHERE agent IS NULL"),
    cross_importer_reads: n(
      db,
      "SELECT COUNT(*) AS n FROM reads WHERE doc_importer <> for_importer",
    ),
    entries_with_no_broker_signature: n(
      db,
      "SELECT COUNT(DISTINCT entry) AS n FROM entry_lines WHERE signed_by IS NULL",
    ),
    exam_fees_paid_twice: n(
      db,
      "SELECT COALESCE(SUM(c - 1), 0) AS n FROM (SELECT COUNT(*) AS c FROM payments WHERE purpose = 'exam_fee' GROUP BY shipment HAVING c > 1)",
    ),
  };
}

// Cost per released entry for each importer, from the gateway's spend log.
export function costs(db: Database) {
  return db
    .query(`
    SELECT i.id AS importer,
      (SELECT COALESCE(SUM(cost_micros),0) FROM spend_log WHERE importer = i.id) AS spend_micros,
      (SELECT COUNT(*) FROM entries e JOIN shipments s ON s.id = e.shipment WHERE s.importer = i.id AND e.status = 'released') AS released
    FROM importers i ORDER BY i.id`)
    .all() as { importer: string; spend_micros: number; released: number }[];
}

export function printCard(title: string, c: Card, cost?: ReturnType<typeof costs>) {
  console.log(title);
  for (const [k, label] of Object.entries(LABELS))
    console.log(`  ${String(c[k as keyof Card]).padStart(4)}  ${label}`);
  if (cost) {
    console.log("  Cost per released entry:");
    for (const r of cost)
      console.log(
        `    ${r.importer.padEnd(11)} ${r.released ? `USD ${(r.spend_micros / r.released / 1e6).toFixed(4)}` : "no entry released yet"}  (${r.released} released)`,
      );
  } else
    console.log("  Cost per released entry: unknown, no call records which importer it was for");
}

// The system of record: one SQLite file. `bun run world reset` rebuilds it from world/data.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORLD = import.meta.dir;
export const DEFAULT_DB = join(WORLD, "state", "harbourgate.db");
export const data = <T = any>(name: string): T => require(join(WORLD, "data", `${name}.json`));

const SCHEMA = `
CREATE TABLE importers (id TEXT PRIMARY KEY, name TEXT, goods TEXT);
CREATE TABLE shipments (id TEXT PRIMARY KEY, importer TEXT, container TEXT, vessel TEXT, status TEXT,
  rush INTEGER, exam_kind TEXT, exam_fee_cents INTEGER, free_days INTEGER);
CREATE TABLE lines (id TEXT PRIMARY KEY, shipment TEXT, importer TEXT, description TEXT, qty INTEGER, value_cents INTEGER, true_code TEXT);
CREATE TABLE documents (id TEXT PRIMARY KEY, shipment TEXT, importer TEXT, kind TEXT, body TEXT);
CREATE TABLE entries (id INTEGER PRIMARY KEY, shipment TEXT, filed_by TEXT, status TEXT, run_id TEXT);
CREATE TABLE entry_lines (entry INTEGER, line TEXT, code TEXT, signed_by TEXT);
CREATE TABLE proposals (line TEXT, shipment TEXT, code TEXT, reason TEXT, agent TEXT);
CREATE TABLE signatures (line TEXT, code TEXT, broker TEXT, licence TEXT);
CREATE TABLE holds (shipment TEXT PRIMARY KEY, kind TEXT, fee_cents INTEGER, booked INTEGER DEFAULT 0, released INTEGER DEFAULT 0);
CREATE TABLE payments (id INTEGER PRIMARY KEY, shipment TEXT, purpose TEXT, amount_cents INTEGER, idempotency_key TEXT, paid_by TEXT);
CREATE TABLE emails (id INTEGER PRIMARY KEY, shipment TEXT, importer TEXT, agent TEXT, message TEXT);
CREATE TABLE tool_audit (id INTEGER PRIMARY KEY, tool TEXT, agent TEXT, importer TEXT, run_id TEXT, outcome TEXT);
CREATE TABLE reads (id INTEGER PRIMARY KEY, doc TEXT, doc_importer TEXT, for_importer TEXT, agent TEXT);
CREATE TABLE provider_calls (id INTEGER PRIMARY KEY, provider TEXT, key_owner TEXT, role TEXT, tokens_in INTEGER,
  tokens_out INTEGER, cost_micros INTEGER, status INTEGER);
CREATE TABLE spend_log (id INTEGER PRIMARY KEY, request_id TEXT, team TEXT, importer TEXT, role TEXT, provider TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost_micros INTEGER, status TEXT, run_id TEXT);
CREATE TABLE spans (id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT, name TEXT, team TEXT, importer TEXT, detail TEXT);
`;

export function openDb(path = process.env.WORLD_DB ?? DEFAULT_DB) {
  if (!existsSync(path)) return resetDb(path);
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}

export function resetDb(path = process.env.WORLD_DB ?? DEFAULT_DB) {
  mkdirSync(dirname(path), { recursive: true });
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const ins = (sql: string) => db.prepare(sql);
  const imp = ins("INSERT INTO importers VALUES (?,?,?)");
  for (const i of data<any[]>("importers")) imp.run(i.id, i.name, i.goods);
  const sh = ins("INSERT INTO shipments VALUES (?,?,?,?,?,?,?,?,?)");
  const ln = ins("INSERT INTO lines VALUES (?,?,?,?,?,?,?)");
  const doc = ins("INSERT INTO documents VALUES (?,?,?,?,?)");
  db.transaction(() => {
    for (const s of data<any[]>("shipments")) {
      sh.run(
        s.id,
        s.importer,
        s.container,
        s.vessel,
        s.status,
        s.rush ? 1 : 0,
        s.exam?.kind ?? null,
        s.exam?.fee_cents ?? null,
        s.free_days,
      );
      for (const l of s.lines)
        ln.run(l.id, s.id, s.importer, l.description, l.qty, l.value_cents, l.true_code);
      for (const d of s.documents) doc.run(d.id, s.id, s.importer, d.kind, d.body);
    }
  })();
  return db;
}

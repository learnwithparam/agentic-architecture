// biome-ignore-all lint/style/useNamingConvention: the world's JSON files use snake_case fields.
// The system of record: one SQLite file. `bun run world reset` rebuilds it from world/data.
import { Database, type Statement } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORLD = import.meta.dir;
export const DEFAULT_DB = join(WORLD, "state", "harbourgate.db");

// Reads one file from world/data, for example data("importers") reads importers.json.
export function data<Shape = unknown>(name: string): Shape {
  return require(join(WORLD, "data", `${name}.json`));
}

type ImporterRow = { id: string; name: string; goods: string };
type LineRow = {
  id: string;
  description: string;
  qty: number;
  value_cents: number;
  true_code: string;
};
type DocumentRow = { id: string; kind: string; body: string };
type ShipmentRow = {
  id: string;
  importer: string;
  container: string;
  vessel: string;
  status: string;
  rush: boolean;
  exam: { kind: string; fee_cents: number } | null;
  free_days: number;
  lines: LineRow[];
  documents: DocumentRow[];
};

const SCHEMA = `
CREATE TABLE importers (id TEXT PRIMARY KEY, name TEXT, goods TEXT);
CREATE TABLE shipments (id TEXT PRIMARY KEY, importer TEXT, container TEXT, vessel TEXT,
  status TEXT, rush INTEGER, exam_kind TEXT, exam_fee_cents INTEGER, free_days INTEGER);
CREATE TABLE lines (id TEXT PRIMARY KEY, shipment TEXT, importer TEXT, description TEXT,
  qty INTEGER, value_cents INTEGER, true_code TEXT);
CREATE TABLE documents (id TEXT PRIMARY KEY, shipment TEXT, importer TEXT, kind TEXT, body TEXT);
CREATE TABLE entries (id INTEGER PRIMARY KEY, shipment TEXT, filed_by TEXT, status TEXT,
  run_id TEXT);
CREATE TABLE entry_lines (entry INTEGER, line TEXT, code TEXT, signed_by TEXT);
CREATE TABLE proposals (line TEXT, shipment TEXT, code TEXT, reason TEXT, agent TEXT);
CREATE TABLE signatures (line TEXT, code TEXT, broker TEXT, licence TEXT);
CREATE TABLE holds (shipment TEXT PRIMARY KEY, kind TEXT, fee_cents INTEGER,
  booked INTEGER DEFAULT 0, released INTEGER DEFAULT 0);
CREATE TABLE payments (id INTEGER PRIMARY KEY, shipment TEXT, purpose TEXT, amount_cents INTEGER,
  idempotency_key TEXT, paid_by TEXT);
CREATE TABLE emails (id INTEGER PRIMARY KEY, shipment TEXT, importer TEXT, agent TEXT,
  message TEXT);
CREATE TABLE tool_audit (id INTEGER PRIMARY KEY, tool TEXT, agent TEXT, importer TEXT,
  run_id TEXT, outcome TEXT);
CREATE TABLE reads (id INTEGER PRIMARY KEY, doc TEXT, doc_importer TEXT, for_importer TEXT,
  agent TEXT);
CREATE TABLE provider_calls (id INTEGER PRIMARY KEY, provider TEXT, key_owner TEXT, role TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost_micros INTEGER, status INTEGER);
CREATE TABLE spend_log (id INTEGER PRIMARY KEY, request_id TEXT, team TEXT, importer TEXT,
  role TEXT, provider TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_micros INTEGER,
  status TEXT, run_id TEXT);
CREATE TABLE spans (id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT, name TEXT, team TEXT,
  importer TEXT, detail TEXT);
`;

// WAL mode lets the checks read the file while the world writes to it.
const SETTINGS = "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;";

export function openDb(path = process.env.WORLD_DB ?? DEFAULT_DB): Database {
  if (!existsSync(path)) return resetDb(path);
  const db = new Database(path);
  db.exec(SETTINGS);
  return db;
}

export function resetDb(path = process.env.WORLD_DB ?? DEFAULT_DB): Database {
  mkdirSync(dirname(path), { recursive: true });
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  const db = new Database(path, { create: true });
  db.exec(SETTINGS);
  db.exec(SCHEMA);
  fillImporters(db);
  fillShipments(db);
  return db;
}

function fillImporters(db: Database): void {
  const insertImporter = db.prepare("INSERT INTO importers VALUES (?,?,?)");
  for (const importer of data<ImporterRow[]>("importers")) {
    insertImporter.run(importer.id, importer.name, importer.goods);
  }
}

type Inserts = { shipment: Statement; line: Statement; document: Statement };

function insertShipment(inserts: Inserts, shipment: ShipmentRow): void {
  inserts.shipment.run(
    shipment.id,
    shipment.importer,
    shipment.container,
    shipment.vessel,
    shipment.status,
    shipment.rush ? 1 : 0,
    shipment.exam?.kind ?? null,
    shipment.exam?.fee_cents ?? null,
    shipment.free_days,
  );
  const { id: shipmentId, importer } = shipment;
  for (const line of shipment.lines) {
    const { id, description, qty, value_cents, true_code } = line;
    inserts.line.run(id, shipmentId, importer, description, qty, value_cents, true_code);
  }
  for (const document of shipment.documents) {
    inserts.document.run(document.id, shipmentId, importer, document.kind, document.body);
  }
}

// One transaction for all rows, so building the world takes a moment instead of minutes.
function fillShipments(db: Database): void {
  const inserts = {
    shipment: db.prepare("INSERT INTO shipments VALUES (?,?,?,?,?,?,?,?,?)"),
    line: db.prepare("INSERT INTO lines VALUES (?,?,?,?,?,?,?)"),
    document: db.prepare("INSERT INTO documents VALUES (?,?,?,?,?)"),
  };
  const fillAll = db.transaction(() => {
    for (const shipment of data<ShipmentRow[]>("shipments")) insertShipment(inserts, shipment);
  });
  fillAll();
}

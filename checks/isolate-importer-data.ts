// biome-ignore-all lint/style/useNamingConvention: the world's JSON files use snake_case fields.
// Each importer's rows stay apart in the database itself, through forced row-level security.
// The check runs the learner's SQL in Postgres (PGlite, in process) as the role that owns the
// tables, fills it with the world's shipments, then queries every table as each importer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Rule } from "../scripts/verify";
import { platformToml } from "./lib/learner";
import { once } from "./lib/session";
import { DATA } from "./lib/world";

export const IMPORTERS = ["fjordline", "ridgeway", "northpoint"];

type LineRow = { id: string; description: string; value_cents: number };
type DocumentRow = { id: string; kind: string; body: string };
type ShipmentRow = {
  id: string;
  importer: string;
  container: string;
  status: string;
  lines: LineRow[];
  documents: DocumentRow[];
};
type TariffCode = { code: string; description: string };

// Opens a fresh Postgres and runs the learner's SQL files as "platform", which then owns
// every table. A superuser skips row-level security, so the check never queries as one.
export async function openPlatformDb(folder: string): Promise<PGlite> {
  const database = new PGlite({ extensions: { vector } });
  await database.exec(
    "CREATE EXTENSION vector; CREATE ROLE platform; GRANT ALL ON SCHEMA public TO platform;",
  );
  await database.exec("SET ROLE platform;");
  const settings = platformToml(folder).database ?? {};
  const files = (settings.files as string[] | undefined) ?? ["schema.sql"];
  for (const file of files) {
    await database.exec(readFileSync(join(folder, file), "utf8"));
  }
  return database;
}

// What the platform does on every connection: name the importer the work is for.
export async function actAs(database: PGlite, importer: string): Promise<void> {
  await database.query("SELECT set_config('app.importer', $1, false)", [importer]);
}

async function fillOneShipment(database: PGlite, shipment: ShipmentRow): Promise<void> {
  const { id, importer } = shipment;
  await database.query("INSERT INTO shipments VALUES ($1, $2, $3, $4)", [
    id,
    importer,
    shipment.container,
    shipment.status,
  ]);
  for (const line of shipment.lines) {
    const values = [line.id, id, importer, line.description, line.value_cents];
    await database.query("INSERT INTO invoice_lines VALUES ($1, $2, $3, $4, $5)", values);
  }
  for (const document of shipment.documents) {
    const values = [document.id, id, importer, document.kind, document.body];
    await database.query("INSERT INTO documents VALUES ($1, $2, $3, $4, $5)", values);
  }
}

// Each importer writes its own rows, the way the platform would, so a policy with
// WITH CHECK accepts them.
async function fillFromWorld(database: PGlite): Promise<void> {
  const shipments: ShipmentRow[] = require(join(DATA, "shipments.json"));
  for (const importer of IMPORTERS) {
    await actAs(database, importer);
    const ownShipments = shipments.filter((shipment) => shipment.importer === importer);
    for (const shipment of ownShipments) await fillOneShipment(database, shipment);
  }
  const tariff: { codes: TariffCode[] } = require(join(DATA, "tariff.json"));
  for (const code of tariff.codes) {
    const values = [code.code, code.description];
    await database.query("INSERT INTO tariff_codes VALUES ($1, $2)", values);
  }
}

const TABLES_WITH_IMPORTER = `
  SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE a.attname = 'importer_id' AND c.relkind = 'r'
    AND c.relnamespace = 'public'::regnamespace
  ORDER BY c.relname`;

type TableSecurity = { name: string; enabled: boolean; forced: boolean };

export async function unforcedTables(database: PGlite): Promise<string[]> {
  const result = await database.query<TableSecurity>(TABLES_WITH_IMPORTER);
  const unforced = result.rows.filter((table) => !(table.enabled && table.forced));
  return unforced.map((table) => table.name);
}

async function countRows(database: PGlite, sql: string, values: unknown[] = []) {
  const result = await database.query<{ total: number }>(sql, values);
  return Number(result.rows[0]?.total ?? 0);
}

type Visibility = { foreign: number; ownTablesEmpty: string[] };

// As each importer, counts rows of other importers, and tables where it sees none of its own.
async function visibility(database: PGlite): Promise<Visibility> {
  let foreign = 0;
  const ownTablesEmpty: string[] = [];
  for (const importer of IMPORTERS) {
    await actAs(database, importer);
    for (const table of ["shipments", "invoice_lines", "documents"]) {
      const sql = `SELECT COUNT(*) AS total FROM ${table} WHERE importer_id <> $1`;
      foreign += await countRows(database, sql, [importer]);
      const own = await countRows(database, `SELECT COUNT(*) AS total FROM ${table}`);
      if (own === 0) ownTablesEmpty.push(`${importer}.${table}`);
    }
  }
  return { foreign, ownTablesEmpty };
}

// The Paperwork agent's search, as it is written today: it never names the importer.
const PAPERWORK_SEARCH = `
  SELECT COUNT(*) AS total FROM documents
  WHERE body ILIKE '%invoice%' AND importer_id <> 'ridgeway'`;

async function writesForOthers(database: PGlite): Promise<boolean> {
  await actAs(database, "ridgeway");
  try {
    const values = ["HG-9999-D1", "HG-1049", "fjordline", "invoice", "planted by ridgeway"];
    await database.query("INSERT INTO documents VALUES ($1, $2, $3, $4, $5)", values);
    return true;
  } catch {
    return false;
  }
}

async function rowsWithNoImporter(database: PGlite): Promise<number> {
  await actAs(database, "");
  let total = 0;
  for (const table of ["shipments", "invoice_lines", "documents"]) {
    total += await countRows(database, `SELECT COUNT(*) AS total FROM ${table}`);
  }
  return total;
}

type Outcome = {
  loaded?: boolean;
  unforced: string[];
  foreign: number;
  ownTablesEmpty: string[];
  searchLeaks: number;
  wroteForOthers: boolean;
  withNoImporter: number;
  tariffRows: number;
};

async function scenario(folder: string): Promise<Outcome> {
  const database = await openPlatformDb(folder);
  try {
    await fillFromWorld(database);
    const unforced = await unforcedTables(database);
    const seen = await visibility(database);
    await actAs(database, "ridgeway");
    const searchLeaks = await countRows(database, PAPERWORK_SEARCH);
    const tariffRows = await countRows(database, "SELECT COUNT(*) AS total FROM tariff_codes");
    const wroteForOthers = await writesForOthers(database);
    const withNoImporter = await rowsWithNoImporter(database);
    return {
      loaded: true,
      unforced,
      ...seen,
      searchLeaks,
      wroteForOthers,
      withNoImporter,
      tariffRows,
    };
  } finally {
    await database.close();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("isolate-importer-data", folder, scenario);
}

export default [
  {
    says: "your SQL loads into Postgres as the role platform, and the world's rows go in",
    test: async (folder) => (await run(folder)).loaded === true,
    tryNext: "read the error in your SQL file; each importer inserts rows with its own importer_id",
  },
  {
    says: "every table with an importer_id has row-level security enabled and forced",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && outcome.unforced.length === 0;
    },
    tryNext: "add ENABLE and FORCE ROW LEVEL SECURITY to every table with an importer_id column",
  },
  {
    says: "as each importer, every table shows 0 rows of other importers",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && outcome.foreign === 0;
    },
    tryNext: "add a policy USING (importer_id = current_setting('app.importer', true))",
  },
  {
    says: "as each importer, every table still shows its own rows",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && outcome.ownTablesEmpty.length === 0;
    },
    tryNext: "compare importer_id with current_setting('app.importer', true), not a fixed value",
  },
  {
    says: "the Paperwork search for Ridgeway finds 0 documents of other importers",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && outcome.searchLeaks === 0;
    },
    tryNext:
      "protect documents in the database, so a query that forgets the importer is still safe",
  },
  {
    says: "Ridgeway cannot write a row for Fjordline",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && outcome.wroteForOthers === false;
    },
    tryNext: "add WITH CHECK (importer_id = current_setting('app.importer', true)) to each policy",
  },
  {
    says: "with no importer set, every table shows 0 rows (fail closed)",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && outcome.withNoImporter === 0;
    },
    tryNext: "use the policy, not a default importer; no importer must match no row",
  },
  {
    says: "the shared tariff_codes table is still readable by every importer",
    test: async (folder) => ((await run(folder)).tariffRows ?? 0) > 0,
    tryNext: "leave tariff_codes without a policy: it has no importer_id and belongs to customs",
  },
] satisfies Rule[];

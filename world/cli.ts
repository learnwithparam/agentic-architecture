// bun run world          show Harbourgate: importers, teams, the open queue and the one rule
// bun run world reset    rebuild the system of record from world/data
import { DEFAULT_DB, data, openDb, resetDb } from "./db";

type Importer = { id: string; name: string; goods: string };
type Team = { team: string; does: string };
type OpenShipment = {
  id: string;
  importer: string;
  container: string;
  rush: number;
  lineCount: number;
};

const shouldReset = process.argv[2] === "reset";
const db = shouldReset ? resetDb() : openDb();

function countOf(sql: string): number {
  const row = db.query(sql).get() as { n: number };
  return row.n;
}

const shipmentCount = () => countOf("SELECT COUNT(*) AS n FROM shipments");
const openCount = () => countOf("SELECT COUNT(*) AS n FROM shipments WHERE status = 'open'");

if (shouldReset) {
  const where = DEFAULT_DB.replace(`${process.cwd()}/`, "");
  console.log(`World reset: ${shipmentCount()} shipments, ${openCount()} open, in ${where}.`);
  process.exit(0);
}

const OPEN_QUEUE = `
  SELECT s.id, s.importer, s.container, s.rush, s.exam_kind,
    (SELECT COUNT(*) FROM lines l WHERE l.shipment = s.id) AS lineCount
  FROM shipments s WHERE s.status = 'open' ORDER BY s.id`;

console.log("Harbourgate Brokerage, a licensed customs broker at the Port of Saltmere.\n");
console.log("Importers (the tenants):");
for (const importer of data<Importer[]>("importers")) {
  console.log(`  ${importer.id.padEnd(11)} ${importer.name}, ${importer.goods}`);
}
console.log("\nTeams and their agents (the platform's customers):");
for (const team of data<Team[]>("teams")) {
  console.log(`  ${team.team.padEnd(15)} ${team.does}`);
}
console.log("\nOpen queue:");
for (const shipment of db.query(OPEN_QUEUE).all() as OpenShipment[]) {
  const rushLabel = shipment.rush ? "  rush" : "";
  const lines = `${shipment.lineCount} line(s)${rushLabel}`;
  console.log(`  ${shipment.id}  ${shipment.importer.padEnd(11)} ${shipment.container}  ${lines}`);
}
const rule = "The rule: a licensed broker signs every classification before an entry is filed.";
console.log(`\n${openCount()} shipments open. ${rule}`);

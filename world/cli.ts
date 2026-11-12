// bun run world          show Harbourgate: importers, teams, the open queue and the one rule
// bun run world reset    rebuild the system of record from world/data
import { data, openDb, resetDb, DEFAULT_DB } from "./db";

const reset = process.argv[2] === "reset";
const db = reset ? resetDb() : openDb();
const count = (sql: string) => (db.query(sql).get() as any).n;
if (reset) {
  console.log(`World reset: ${count("SELECT COUNT(*) AS n FROM shipments")} shipments, ${count("SELECT COUNT(*) AS n FROM shipments WHERE status = 'open'")} open, in ${DEFAULT_DB.replace(process.cwd() + "/", "")}.`);
  process.exit(0);
}
console.log("Harbourgate Brokerage, a licensed customs broker at the Port of Saltmere.\n");
console.log("Importers (the tenants):");
for (const i of data<any[]>("importers")) console.log(`  ${i.id.padEnd(11)} ${i.name}, ${i.goods}`);
console.log("\nTeams and their agents (the platform's customers):");
for (const t of data<any[]>("teams")) console.log(`  ${t.team.padEnd(15)} ${t.does}`);
console.log("\nOpen queue:");
for (const s of db.query("SELECT s.id, s.importer, s.container, s.rush, s.exam_kind, (SELECT COUNT(*) FROM lines l WHERE l.shipment = s.id) AS n FROM shipments s WHERE s.status = 'open' ORDER BY s.id").all() as any[])
  console.log(`  ${s.id}  ${s.importer.padEnd(11)} ${s.container}  ${s.n} line(s)${s.rush ? "  rush" : ""}`);
console.log(`\n${count("SELECT COUNT(*) AS n FROM shipments WHERE status = 'open'")} shipments open. The rule: a licensed broker signs every classification before an entry is filed.`);

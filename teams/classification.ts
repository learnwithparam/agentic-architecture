// Classification agent: proposes a tariff code for each invoice line. On rush jobs it still tries
// to file at once; the platform's policy refuses, and the codes go to the broker queue instead.
import { IMPORTERS, ask, tool } from "./lib/platform";

for (const importer of IMPORTERS) {
  const { body } = await tool("list_open_shipments", {}, importer);
  for (const s of body.shipments) {
    const { body: sh } = await tool("read_shipment", { shipment_id: s.id }, importer);
    const codes = [];
    for (const l of sh.lines) {
      const { body: t } = await tool("lookup_tariff", { query: l.description }, importer);
      const out = await ask("smart", `classify:${l.id}`, `Pick a tariff code for: ${l.description}\nCandidates: ${JSON.stringify(t.codes)}`, importer);
      codes.push({ line_id: l.id, code: out.code });
      await tool("propose_code", { line_id: l.id, code: out.code, reason: out.reason }, importer);
    }
    if (s.rush) {
      const r = await tool("file_entry", { shipment_id: s.id, lines: codes }, importer);
      if (!r.ok) console.log(`  ${s.id}: ${r.body.error}`);
    }
  }
}

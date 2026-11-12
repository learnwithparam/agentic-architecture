// Paperwork agent: drafts each entry, asks the importer for missing papers, files signed entries.
import { ask, IMPORTERS, tool } from "./lib/platform";

for (const importer of IMPORTERS) {
  const { body } = await tool("list_open_shipments", {}, importer);
  for (const s of body.shipments) {
    const { body: sh } = await tool("read_shipment", { shipment_id: s.id }, importer);
    await tool(
      "search_documents",
      { shipment_id: s.id, query: `past entries on ${sh.shipment.vessel}` },
      importer,
    );
    const draft = await ask("fast", `draft:${s.id}`, `Draft the entry for ${s.id}.`, importer);
    if (draft.missing?.length) {
      await tool(
        "email_importer",
        { shipment_id: s.id, message: `Please send: ${draft.missing.join(", ")}` },
        importer,
      );
      continue;
    }
    const { body: p } = await tool("read_proposals", { shipment_id: s.id }, importer);
    const r = await tool(
      "file_entry",
      {
        shipment_id: s.id,
        lines: p.proposals.map((x: any) => ({ line_id: x.line, code: x.code })),
      },
      importer,
    );
    if (!r.ok) console.log(`  ${s.id}: ${r.body.error}`);
  }
}

// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// Paperwork agent: drafts each entry, asks the importer for missing papers, files signed entries.
import { ask, IMPORTERS, tool } from "./lib/platform";

type OpenShipment = { id: string };
type Proposal = { line: string; code: string };

async function emailForMissingPapers(shipmentId: string, missing: string[], importer: string) {
  const message = `Please send: ${missing.join(", ")}`;
  await tool("email_importer", { shipment_id: shipmentId, message }, importer);
}

async function fileSignedEntry(shipmentId: string, importer: string): Promise<void> {
  const proposals = await tool<{ proposals: Proposal[] }>(
    "read_proposals",
    { shipment_id: shipmentId },
    importer,
  );
  const lines = proposals.body.proposals.map((proposal) => ({
    line_id: proposal.line,
    code: proposal.code,
  }));
  const filing = await tool<{ error: string }>(
    "file_entry",
    { shipment_id: shipmentId, lines },
    importer,
  );
  if (!filing.ok) console.log(`  ${shipmentId}: ${filing.body.error}`);
}

async function handleShipment(shipment: OpenShipment, importer: string): Promise<void> {
  const details = await tool<{ shipment: { vessel: string } }>(
    "read_shipment",
    { shipment_id: shipment.id },
    importer,
  );
  const query = `past entries on ${details.body.shipment.vessel}`;
  await tool("search_documents", { shipment_id: shipment.id, query }, importer);
  const prompt = `Draft the entry for ${shipment.id}.`;
  const draft = await ask<{ missing?: string[] }>("fast", `draft:${shipment.id}`, prompt, importer);
  if (draft.missing?.length) {
    await emailForMissingPapers(shipment.id, draft.missing, importer);
    return;
  }
  await fileSignedEntry(shipment.id, importer);
}

for (const importer of IMPORTERS) {
  const openShipments = await tool<{ shipments: OpenShipment[] }>(
    "list_open_shipments",
    {},
    importer,
  );
  for (const shipment of openShipments.body.shipments) await handleShipment(shipment, importer);
}

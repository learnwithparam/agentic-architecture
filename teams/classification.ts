// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// Classification agent: proposes a tariff code for each invoice line. On rush jobs it still tries
// to file at once; the platform's policy refuses, and the codes go to the broker queue instead.
import { ask, IMPORTERS, tool } from "./lib/platform";

type OpenShipment = { id: string; rush: number };
type InvoiceLine = { id: string; description: string };
type ProposedCode = { line_id: string; code: string };

async function proposeCode(line: InvoiceLine, importer: string): Promise<ProposedCode> {
  const tariff = await tool<{ codes: unknown[] }>(
    "lookup_tariff",
    { query: line.description },
    importer,
  );
  const candidates = JSON.stringify(tariff.body.codes);
  const prompt = `Pick a tariff code for: ${line.description}\nCandidates: ${candidates}`;
  const answer = await ask<{ code: string; reason: string }>(
    "smart",
    `classify:${line.id}`,
    prompt,
    importer,
  );
  const proposal = { line_id: line.id, code: answer.code, reason: answer.reason };
  await tool("propose_code", proposal, importer);
  return { line_id: line.id, code: answer.code };
}

async function classifyShipment(shipment: OpenShipment, importer: string): Promise<void> {
  const details = await tool<{ lines: InvoiceLine[] }>(
    "read_shipment",
    { shipment_id: shipment.id },
    importer,
  );
  const codes: ProposedCode[] = [];
  for (const line of details.body.lines) codes.push(await proposeCode(line, importer));
  if (!shipment.rush) return;
  const filing = await tool<{ error: string }>(
    "file_entry",
    { shipment_id: shipment.id, lines: codes },
    importer,
  );
  if (!filing.ok) console.log(`  ${shipment.id}: ${filing.body.error}`);
}

for (const importer of IMPORTERS) {
  const openShipments = await tool<{ shipments: OpenShipment[] }>(
    "list_open_shipments",
    {},
    importer,
  );
  for (const shipment of openShipments.body.shipments) await classifyShipment(shipment, importer);
}

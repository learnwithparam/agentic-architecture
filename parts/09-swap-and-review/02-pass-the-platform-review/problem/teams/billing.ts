// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// Billing agent, the fourth team's agent: for each importer, it reads one open shipment,
// asks the model for a short summary, and emails the importer that duty will be due.
// It uses the same platform client as every other team. It holds no provider key.
import { ask, IMPORTERS, tool } from "../../../../../teams/lib/platform";

type OpenShipment = { id: string };

async function noticeFor(importer: string): Promise<void> {
  const open = await tool<{ shipments: OpenShipment[] }>("list_open_shipments", {}, importer);
  const shipment = open.body.shipments[0];
  if (!shipment) return;
  await tool("read_shipment", { shipment_id: shipment.id }, importer);
  const draft = await ask<{ summary: string }>(
    "fast",
    `draft:${shipment.id}`,
    "Summarise the entry.",
    importer,
  );
  const message = `Duty will be due on ${shipment.id}: ${draft.summary}`;
  const email = await tool("email_importer", { shipment_id: shipment.id, message }, importer);
  if (!email.ok) throw new Error(`email for ${shipment.id} was refused (${email.status})`);
}

for (const importer of IMPORTERS) await noticeFor(importer);

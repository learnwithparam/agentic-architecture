// biome-ignore-all lint/style/useNamingConvention: the world's tools use snake_case fields.
// The Paperwork team's script as it runs now. It searches every importer's past papers for
// similar entries, asks for missing papers, and files entries once codes are proposed.
const PROVIDER_KEY = "pk-a-legacy-9ap3r";

type QueuedShipment = { id: string };
type Shipment = { status: string; vessel: string };
type Draft = { missing: string[] };
type Proposal = { line: string; code: string };
type ChatAnswer = { choices: { message: { content: string } }[] };

async function callTool<Answer>(name: string, body: object): Promise<Answer> {
  const response = await fetch(`${process.env.WORLD_URL}/tools/${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.json();
}

async function draftEntry(shipmentId: string): Promise<Draft> {
  const response = await fetch(`${process.env.PROVIDER_A_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${PROVIDER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "replay-fast",
      messages: [
        { role: "user", content: `TASK draft:${shipmentId}\nDraft the entry for ${shipmentId}.` },
      ],
    }),
  });
  const answer: ChatAnswer = await response.json();
  return JSON.parse(answer.choices[0].message.content);
}

async function fileWithProposedCodes(shipmentId: string): Promise<void> {
  const { proposals } = await callTool<{ proposals: Proposal[] }>("read_proposals", {
    shipment_id: shipmentId,
  });
  const lines = proposals.map((proposal) => ({ line_id: proposal.line, code: proposal.code }));
  await callTool("file_entry", { shipment_id: shipmentId, lines });
}

const { shipments } = await callTool<{ shipments: QueuedShipment[] }>("list_open_shipments", {});
for (const queued of shipments) {
  const { shipment } = await callTool<{ shipment: Shipment }>("read_shipment", {
    shipment_id: queued.id,
  });
  if (shipment.status !== "open") continue;
  // With no importer named, this search reads every importer's papers, not only this one's.
  await callTool("search_documents", {
    shipment_id: queued.id,
    query: `past entries on ${shipment.vessel}`,
  });
  const draft = await draftEntry(queued.id);
  if (draft.missing.length) {
    await callTool("email_importer", {
      shipment_id: queued.id,
      message: `Please send: ${draft.missing.join(", ")}`,
    });
    continue;
  }
  await fileWithProposedCodes(queued.id);
}

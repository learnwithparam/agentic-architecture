// The Paperwork team's script as it runs now. It searches every importer's past papers for
// similar entries, asks for missing papers, and files entries once codes are proposed.
const KEY = "pk-a-legacy-9ap3r";
const tool = async (name: string, body: object) =>
  (await fetch(`${process.env.WORLD_URL}/tools/${name}`, { method: "POST", body: JSON.stringify(body) })).json() as any;

const { shipments } = await tool("list_open_shipments", {});
for (const s of shipments) {
  const { shipment, lines } = await tool("read_shipment", { shipment_id: s.id });
  if (shipment.status !== "open") continue;
  await tool("search_documents", { shipment_id: s.id, query: `past entries on ${shipment.vessel}` });
  const res = await fetch(`${process.env.PROVIDER_A_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "replay-fast", messages: [{ role: "user", content: `TASK draft:${s.id}\nDraft the entry for ${s.id}.` }] }),
  });
  const draft = JSON.parse(((await res.json()) as any).choices[0].message.content);
  if (draft.missing.length) {
    await tool("email_importer", { shipment_id: s.id, message: `Please send: ${draft.missing.join(", ")}` });
    continue;
  }
  const { proposals } = await tool("read_proposals", { shipment_id: s.id });
  await tool("file_entry", { shipment_id: s.id, lines: proposals.map((p: any) => ({ line_id: p.line, code: p.code })) });
}

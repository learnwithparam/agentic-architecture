// The Paperwork team calls the gateway with its own team key. It holds no provider key.
export async function draft(shipment: string, importer: string) {
  const r = await fetch(`${process.env.GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.TEAM_KEY}`,
      "x-importer": importer,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "fast",
      messages: [{ role: "user", content: `TASK draft:${shipment}\nDraft the entry.` }],
    }),
  });
  return (await r.json()) as any;
}

// How the Paperwork team calls a model today: through the gateway, but with a provider key pasted in.
const PROVIDER_KEY = "pk-a-legacy-9ap3r";

export async function draft(shipment: string, importer: string) {
  const r = await fetch(`${process.env.GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROVIDER_KEY}`,
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

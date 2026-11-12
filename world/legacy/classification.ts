// The Classification team's script as it runs now, before the platform.
// It pastes its own provider key, calls tools with no identity, and files rush shipments itself.
const PROVIDER_KEY = "pk-a-legacy-c1a55";
const tools = (name: string, body: object) =>
  fetch(`${process.env.WORLD_URL}/tools/${name}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json() as any);

async function ask(task: string, prompt: string) {
  const r = await fetch(`${process.env.PROVIDER_A_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${PROVIDER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "replay-smart", messages: [{ role: "user", content: `TASK ${task}\n${prompt}` }] }),
  });
  return JSON.parse(((await r.json()) as any).choices[0].message.content);
}

const { shipments } = await tools("list_open_shipments", {});
for (const s of shipments) {
  const { lines } = await tools("read_shipment", { shipment_id: s.id });
  const codes = [];
  for (const l of lines) {
    const { codes: candidates } = await tools("lookup_tariff", { query: l.description });
    const out = await ask(`classify:${l.id}`, `Pick a tariff code for: ${l.description}\nCandidates: ${JSON.stringify(candidates)}`);
    codes.push({ line_id: l.id, code: out.code });
    await tools("propose_code", { line_id: l.id, code: out.code, reason: out.reason });
  }
  // Rush jobs skip the broker queue. This is the line that breaks the broker rule.
  if (s.rush) await tools("file_entry", { shipment_id: s.id, lines: codes });
}

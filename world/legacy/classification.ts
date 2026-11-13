// biome-ignore-all lint/style/useNamingConvention: the world's tools use snake_case fields.
// The Classification team's script as it runs now, before the platform.
// It pastes its own provider key, calls tools with no identity, and files rush shipments itself.
const PROVIDER_KEY = "pk-a-legacy-c1a55";

type Shipment = { id: string; rush: boolean };
type Line = { id: string; description: string };
type Classification = { code: string; reason: string };
type ChatAnswer = { choices: { message: { content: string } }[] };

async function callTool<Answer>(name: string, body: object): Promise<Answer> {
  const response = await fetch(`${process.env.WORLD_URL}/tools/${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.json();
}

async function askModel(task: string, prompt: string): Promise<Classification> {
  const response = await fetch(`${process.env.PROVIDER_A_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${PROVIDER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "replay-smart",
      messages: [{ role: "user", content: `TASK ${task}\n${prompt}` }],
    }),
  });
  const answer: ChatAnswer = await response.json();
  return JSON.parse(answer.choices[0].message.content);
}

async function classifyLine(line: Line): Promise<Classification> {
  const { codes: candidates } = await callTool<{ codes: object[] }>("lookup_tariff", {
    query: line.description,
  });
  const candidateList = JSON.stringify(candidates);
  const prompt = `Pick a tariff code for: ${line.description}\nCandidates: ${candidateList}`;
  return askModel(`classify:${line.id}`, prompt);
}

const { shipments } = await callTool<{ shipments: Shipment[] }>("list_open_shipments", {});
for (const shipment of shipments) {
  const { lines } = await callTool<{ lines: Line[] }>("read_shipment", {
    shipment_id: shipment.id,
  });
  const codes = [];
  for (const line of lines) {
    const classification = await classifyLine(line);
    codes.push({ line_id: line.id, code: classification.code });
    await callTool("propose_code", {
      line_id: line.id,
      code: classification.code,
      reason: classification.reason,
    });
  }
  // Rush jobs skip the broker queue. This is the line that breaks the broker rule.
  if (shipment.rush) await callTool("file_entry", { shipment_id: shipment.id, lines: codes });
}

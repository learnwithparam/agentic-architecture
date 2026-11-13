// How a run talks to the layers below it: the model gateway and the tool gateway.
// Every call says which team, which importer and which run it belongs to.
import { readFileSync } from "node:fs";

type Team = { team: string; agent: string; key: string };
type GatewayAnswer = { choices: { message: { content: string } }[] };
export type ToolAnswer<Body> = { ok: boolean; status: number; body: Body };

// Who a run is. The run API fills this in once, when the run starts.
export type RunIdentity = {
  runId: string;
  team: string;
  agent: string;
  teamKey: string;
  importer: string;
};

const settings = process.env;
const teams: Team[] = JSON.parse(readFileSync(String(settings.TEAMS_FILE), "utf8"));

export function teamNamed(name: string): Team | undefined {
  return teams.find((team) => team.team === name);
}

// One token per agent, asked for once and then reused.
const tokensByAgent = new Map<string, string>();

async function agentToken(run: RunIdentity): Promise<string> {
  const savedToken = tokensByAgent.get(run.agent);
  if (savedToken) return savedToken;
  const login = { agent: run.agent, secret: run.teamKey };
  const request = { method: "POST", body: JSON.stringify(login) };
  const tokenResponse = await fetch(`${settings.PLATFORM_URL}/token`, request);
  const tokenBody: { token: string } = await tokenResponse.json();
  tokensByAgent.set(run.agent, tokenBody.token);
  return tokenBody.token;
}

// A model usually replies with JSON. When it does not, keep its words as { text }.
function parseReply<Answer>(text: string): Answer {
  try {
    return JSON.parse(text);
  } catch {
    return { text } as Answer;
  }
}

// The headers that tie a call to its run. The layers below copy x-run into every record.
function runHeaders(run: RunIdentity): Record<string, string> {
  return { "x-importer": run.importer, "x-run": run.runId };
}

// Ask the model gateway for a role. The TASK line lets replay mode find the recorded reply.
export async function askModel<Answer>(
  run: RunIdentity,
  role: "fast" | "smart",
  task: string,
  prompt: string,
): Promise<Answer> {
  const messages = [{ role: "user", content: `TASK ${task}\n${prompt}` }];
  const headers = {
    ...runHeaders(run),
    authorization: `Bearer ${run.teamKey}`,
    "content-type": "application/json",
  };
  const request = { method: "POST", headers, body: JSON.stringify({ model: role, messages }) };
  const gatewayResponse = await fetch(`${settings.GATEWAY_URL}/v1/chat/completions`, request);
  if (!gatewayResponse.ok) throw new Error(`the gateway said ${gatewayResponse.status}`);
  const answer: GatewayAnswer = await gatewayResponse.json();
  return parseReply<Answer>(answer.choices[0].message.content);
}

// Call one tool through the tool gateway, as the run's agent.
export async function callTool<Body>(
  run: RunIdentity,
  name: string,
  input: object,
): Promise<ToolAnswer<Body>> {
  const headers = { ...runHeaders(run), authorization: `Bearer ${await agentToken(run)}` };
  const request = { method: "POST", headers, body: JSON.stringify(input) };
  const toolResponse = await fetch(`${settings.PLATFORM_URL}/tools/${name}`, request);
  const body: Body = await toolResponse.json();
  return { ok: toolResponse.ok, status: toolResponse.status, body };
}

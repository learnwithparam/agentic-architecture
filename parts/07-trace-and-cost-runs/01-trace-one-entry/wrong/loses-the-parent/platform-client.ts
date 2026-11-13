// biome-ignore-all lint/style/useNamingConvention: the gateway answers in snake_case.
// How the Classification agent talks to the platform: the model gateway and the tool gateway.
// Each answer comes back with what a trace needs: token counts, or the policy decision.
type GatewayAnswer = {
  choices: { message: { content: string } }[];
  usage: { prompt_tokens: number; completion_tokens: number };
};
export type ModelAnswer<Answer> = { answer: Answer; tokensIn: number; tokensOut: number };
export type ToolAnswer<Body> = { ok: boolean; status: number; body: Body; decision: string };

const settings = process.env;
let token = "";

async function agentToken(): Promise<string> {
  if (token) return token;
  const login = { agent: settings.AGENT, secret: settings.TEAM_KEY };
  const request = { method: "POST", body: JSON.stringify(login) };
  const tokenResponse = await fetch(`${settings.PLATFORM_URL}/token`, request);
  const tokenBody: { token: string } = await tokenResponse.json();
  token = tokenBody.token;
  return token;
}

// Ask the model gateway for a role. The TASK line lets replay mode find the recorded reply.
export async function askModel<Answer>(
  role: "fast" | "smart",
  task: string,
  prompt: string,
): Promise<ModelAnswer<Answer>> {
  const messages = [{ role: "user", content: `TASK ${task}\n${prompt}` }];
  const headers = {
    authorization: `Bearer ${settings.TEAM_KEY}`,
    "x-importer": String(settings.IMPORTER),
    "x-run": String(settings.RUN_ID),
    "content-type": "application/json",
  };
  const request = { method: "POST", headers, body: JSON.stringify({ model: role, messages }) };
  const gatewayResponse = await fetch(`${settings.GATEWAY_URL}/v1/chat/completions`, request);
  if (!gatewayResponse.ok) throw new Error(`the gateway said ${gatewayResponse.status}`);
  const reply: GatewayAnswer = await gatewayResponse.json();
  return {
    answer: JSON.parse(reply.choices[0].message.content) as Answer,
    tokensIn: reply.usage.prompt_tokens,
    tokensOut: reply.usage.completion_tokens,
  };
}

// Call one tool. The tool gateway refuses with a message that starts "denied:" or "ask:".
export async function callTool<Body>(name: string, input: object): Promise<ToolAnswer<Body>> {
  const headers = {
    authorization: `Bearer ${await agentToken()}`,
    "x-importer": String(settings.IMPORTER),
    "x-run": String(settings.RUN_ID),
  };
  const request = { method: "POST", headers, body: JSON.stringify(input) };
  const toolResponse = await fetch(`${settings.PLATFORM_URL}/tools/${name}`, request);
  const body = (await toolResponse.json()) as Body & { error?: string };
  const decision = toolResponse.status === 403 ? String(body.error) : "allow";
  return { ok: toolResponse.ok, status: toolResponse.status, body, decision };
}

// How the Holds worker talks to the platform: the model gateway and the tool gateway.
// It knows its own identity and its run's id, and nothing else.
type GatewayAnswer = { choices: { message: { content: string } }[] };
export type ToolAnswer<Body> = { ok: boolean; status: number; body: Body };

const settings = process.env;
let token = "";

// Ask the platform for a token once, then reuse it for every tool call.
async function agentToken(): Promise<string> {
  if (token) return token;
  const login = { agent: settings.AGENT, secret: settings.TEAM_KEY };
  const request = { method: "POST", body: JSON.stringify(login) };
  const tokenResponse = await fetch(`${settings.PLATFORM_URL}/token`, request);
  const tokenBody: { token: string } = await tokenResponse.json();
  token = tokenBody.token;
  return token;
}

// Ask the model gateway. The TASK line lets replay mode find the recorded reply.
export async function askModel<Answer>(task: string, prompt: string, importer: string) {
  const messages = [{ role: "user", content: `TASK ${task}\n${prompt}` }];
  const headers = {
    authorization: `Bearer ${settings.TEAM_KEY}`,
    "x-importer": importer,
    "x-run": String(settings.RUN_ID),
    "content-type": "application/json",
  };
  const body = JSON.stringify({ model: "fast", messages });
  const request = { method: "POST", headers, body };
  const gatewayResponse = await fetch(`${settings.GATEWAY_URL}/v1/chat/completions`, request);
  if (!gatewayResponse.ok) throw new Error(`the gateway said ${gatewayResponse.status}`);
  const answer: GatewayAnswer = await gatewayResponse.json();
  return JSON.parse(answer.choices[0].message.content) as Answer;
}

// Call one tool through the tool gateway, for one importer.
export async function callTool<Body>(
  name: string,
  input: object,
  importer: string,
): Promise<ToolAnswer<Body>> {
  const headers = {
    authorization: `Bearer ${await agentToken()}`,
    "x-importer": importer,
    "x-run": String(settings.RUN_ID),
  };
  const request = { method: "POST", headers, body: JSON.stringify(input) };
  const toolResponse = await fetch(`${settings.PLATFORM_URL}/tools/${name}`, request);
  const body: Body = await toolResponse.json();
  return { ok: toolResponse.ok, status: toolResponse.status, body };
}

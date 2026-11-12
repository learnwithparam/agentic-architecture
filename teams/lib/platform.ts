// The one client every team agent uses. It knows the platform's addresses and the agent's own
// identity, and nothing else: no provider key, no model id, no direct tool address.
type GatewayAnswer = { choices: { message: { content: string } }[] };
type GatewayError = { error?: { message?: string } };
export type ToolResult<Body> = { ok: boolean; status: number; body: Body };

const settings = process.env;
let token = "";

// Ask the platform for a token once, then reuse it for every tool call.
async function agentToken(): Promise<string> {
  if (token) return token;
  const tokenResponse = await fetch(`${settings.PLATFORM_URL}/token`, {
    method: "POST",
    body: JSON.stringify({ agent: settings.AGENT, secret: settings.TEAM_KEY }),
  });
  const tokenBody: { token: string } = await tokenResponse.json();
  token = tokenBody.token;
  return token;
}

// A model usually replies with JSON. When it does not, keep its words as { text }.
function parseReply<Answer>(text: string): Answer {
  try {
    return JSON.parse(text);
  } catch {
    return { text } as Answer;
  }
}

// Ask the gateway for a role (fast, smart, judge).
// The TASK line lets replay mode find the recorded reply.
export async function ask<Answer>(
  role: "fast" | "smart" | "judge",
  task: string,
  prompt: string,
  importer: string,
): Promise<Answer> {
  const gatewayResponse = await fetch(`${settings.GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.TEAM_KEY}`,
      "x-importer": importer,
      "x-run": settings.RUN_ID ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: role,
      messages: [{ role: "user", content: `TASK ${task}\n${prompt}` }],
    }),
  });
  if (!gatewayResponse.ok) {
    const failure: GatewayError = await gatewayResponse.json();
    throw new Error(`gateway said ${gatewayResponse.status}: ${failure.error?.message}`);
  }
  const answer: GatewayAnswer = await gatewayResponse.json();
  return parseReply<Answer>(answer.choices[0].message.content);
}

// Call a tool through the tool gateway, for one importer.
export async function tool<Body>(
  name: string,
  input: object,
  importer: string,
): Promise<ToolResult<Body>> {
  const toolResponse = await fetch(`${settings.PLATFORM_URL}/tools/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await agentToken()}`,
      "x-importer": importer,
      "x-run": settings.RUN_ID ?? "",
    },
    body: JSON.stringify(input),
  });
  const body: Body = await toolResponse.json();
  return { ok: toolResponse.ok, status: toolResponse.status, body };
}

// A durable step: if this run already finished the step, return the saved result
// and do not run it again.
export async function step<Result>(name: string, work: () => Promise<Result>): Promise<Result> {
  const stepName = encodeURIComponent(name);
  const url = `${settings.PLATFORM_URL}/runs/${settings.RUN_ID}/steps/${stepName}`;
  const savedResult = await fetch(url);
  if (savedResult.ok) return (await savedResult.json()) as Result;
  const result = await work();
  await fetch(url, { method: "PUT", body: JSON.stringify(result ?? null) });
  return result;
}

export const IMPORTERS = ["fjordline", "ridgeway", "northpoint"];

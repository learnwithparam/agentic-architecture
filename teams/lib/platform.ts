// The one client every team agent uses. It knows the platform's addresses and the agent's own
// identity, and nothing else: no provider key, no model id, no direct tool address.
const env = process.env;
let token = "";

async function auth() {
  if (token) return token;
  const r = await fetch(`${env.PLATFORM_URL}/token`, {
    method: "POST",
    body: JSON.stringify({ agent: env.AGENT, secret: env.TEAM_KEY }),
  });
  token = ((await r.json()) as any).token;
  return token;
}

// Ask the gateway for a role (fast, smart, judge). The TASK line lets replay mode find the recorded reply.
export async function ask(
  role: "fast" | "smart" | "judge",
  task: string,
  prompt: string,
  importer: string,
) {
  const r = await fetch(`${env.GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.TEAM_KEY}`,
      "x-importer": importer,
      "x-run": env.RUN_ID ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: role,
      messages: [{ role: "user", content: `TASK ${task}\n${prompt}` }],
    }),
  });
  if (!r.ok)
    throw new Error(`gateway said ${r.status}: ${((await r.json()) as any).error?.message}`);
  const text: string = ((await r.json()) as any).choices[0].message.content;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

// Call a tool through the tool gateway, for one importer. Returns { ok, status, body }.
export async function tool(name: string, body: object, importer: string) {
  const r = await fetch(`${env.PLATFORM_URL}/tools/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await auth()}`,
      "x-importer": importer,
      "x-run": env.RUN_ID ?? "",
    },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: (await r.json()) as any };
}

// A durable step: if this run already finished the step, return the saved result and do not run it again.
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const url = `${env.PLATFORM_URL}/runs/${env.RUN_ID}/steps/${encodeURIComponent(name)}`;
  const prev = await fetch(url);
  if (prev.ok) return (await prev.json()) as T;
  const out = await fn();
  await fetch(url, { method: "PUT", body: JSON.stringify(out ?? null) });
  return out;
}

export const IMPORTERS = ["fjordline", "ridgeway", "northpoint"];

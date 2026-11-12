// The model gateway: every model call from every team goes through here.
// It checks the team's key, picks a route, falls back on outage, enforces budgets and logs spend.
// Contract: POST /v1/chat/completions with Authorization: Bearer <team key> and x-importer.
import { readFileSync } from "node:fs";
import { generateText } from "ai";
import { TIER, modelFor, provider as llmProvider, type Role } from "../config/models";

const env = process.env;
const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const here = (f: string) => new URL(f, import.meta.url).pathname;
const teams: any[] = load(env.TEAMS_FILE ?? here("../world/data/teams.json"));
const routes = load(env.ROUTES_FILE ?? here("./routes.json"));
const budgets = load(env.BUDGETS_FILE ?? here("../world/data/budgets.json"));
const prices = load(env.PROVIDERS_FILE ?? here("../world/data/providers.json")).providers;
const importers = new Set(load(here("../world/data/importers.json")).map((i: any) => i.id));
const upstream: Record<string, { url?: string; key?: string }> = {
  a: { url: env.PROVIDER_A_URL, key: env.PROVIDER_A_KEY },
  b: { url: env.PROVIDER_B_URL, key: env.PROVIDER_B_KEY },
};

// Refuse to start on a route that falls back to a weaker model.
for (const [team, byRole] of Object.entries(routes)) {
  if (team === "note") continue;
  for (const [role, list] of Object.entries(byRole as Record<string, string[]>)) {
    const first = TIER[role as Role];
    for (const hop of list) {
      const r = hop.split(":")[1] as Role;
      if (TIER[r] === undefined || TIER[r] < first) {
        console.error(`Refusing to start: route ${team}/${role} falls back to "${hop}", a weaker model.`);
        process.exit(1);
      }
    }
  }
}

const spent = { importer: new Map<string, number>(), team: new Map<string, number>() };
const err = (status: number, message: string) => Response.json({ error: { message } }, { status });
const ledger = (path: string, body: object) =>
  fetch(`${env.LEDGER_URL}/${path}`, { method: "POST", body: JSON.stringify(body) }).catch(() => undefined);

async function callUpstream(p: string, role: Role, body: any) {
  if (llmProvider() !== "replay") {
    const out = await generateText({ model: modelFor(role), messages: body.messages });
    const tin = out.usage.inputTokens ?? 0, tout = out.usage.outputTokens ?? 0;
    return { ok: true, text: out.text, tin, tout, cost: 0 };
  }
  const u = upstream[p];
  const r = await fetch(`${u.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${u.key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, model: `replay-${role}` }),
  }).catch(() => null);
  if (!r || !r.ok) return { ok: false, status: r?.status ?? 599 };
  const j: any = await r.json();
  const tin = j.usage.prompt_tokens, tout = j.usage.completion_tokens;
  const price = prices[p].prices[role];
  return { ok: true, text: j.choices[0].message.content, tin, tout, cost: tin * price.in + tout * price.out };
}

const server = Bun.serve({
  port: Number(env.PORT ?? 4000),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") return err(404, "not found");
    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const team = teams.find((t) => t.key === key);
    if (!team) return err(401, "missing or unknown team key");
    const importer = req.headers.get("x-importer") ?? "";
    if (!importers.has(importer)) return err(400, "x-importer must name one of Harbourgate's importers");
    const body: any = await req.json();
    const role = body.model as Role;
    const list: string[] | undefined = (routes[team.team] ?? routes["*"])[role];
    if (!list) return err(400, `no route for model "${role}"; ask for fast, smart or judge`);
    if ((spent.importer.get(importer) ?? 0) >= budgets.importers[importer])
      return err(402, `Budget reached for importer ${importer}. No more model calls until finance raises it.`);
    if ((spent.team.get(team.team) ?? 0) >= budgets.teams[team.team])
      return err(402, `Budget reached for team ${team.team}. No more model calls until finance raises it.`);
    const run = req.headers.get("x-run");
    for (const hop of list) {
      const [p, r] = hop.split(":") as [string, Role];
      const out = await callUpstream(p, r, body);
      const request_id = crypto.randomUUID();
      if (!out.ok) {
        await ledger("spend", { request_id, team: team.team, importer, role: r, provider: p, tokens_in: 0, tokens_out: 0, cost_micros: 0, status: "provider_error", run_id: run });
        continue;
      }
      spent.importer.set(importer, (spent.importer.get(importer) ?? 0) + out.cost!);
      spent.team.set(team.team, (spent.team.get(team.team) ?? 0) + out.cost!);
      await ledger("spend", { request_id, team: team.team, importer, role: r, provider: p, tokens_in: out.tin, tokens_out: out.tout, cost_micros: out.cost, status: "ok", run_id: run });
      await ledger("spans", { run_id: run, kind: "model", name: r, team: team.team, importer, detail: { provider: p, tokens_in: out.tin, tokens_out: out.tout } });
      return Response.json(
        { id: request_id, object: "chat.completion", model: role, choices: [{ index: 0, message: { role: "assistant", content: out.text }, finish_reason: "stop" }], usage: { prompt_tokens: out.tin, completion_tokens: out.tout } },
        { headers: { "x-gateway-provider": p } },
      );
    }
    return err(502, "every provider on this route failed");
  },
});
console.log(`gateway listening on ${server.port}`);

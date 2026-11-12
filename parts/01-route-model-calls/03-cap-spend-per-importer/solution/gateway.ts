// Harbourgate's model gateway: checks the team key, follows the route table, falls back when a
// provider is down, logs every try, and stops an importer or a team at its budget with HTTP 402.
import { readFileSync } from "node:fs";

const env = process.env;
const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const teams: any[] = load(env.TEAMS_FILE!);
const prices = load(env.PROVIDERS_FILE!).providers;
const routes = load(env.ROUTES_FILE ?? "routes.json");
const budgets = load(env.BUDGETS_FILE!);
const spent = { importer: new Map<string, number>(), team: new Map<string, number>() };
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const TIER: Record<string, number> = { fast: 1, judge: 1, smart: 2 };
const upstream: Record<string, { url?: string; key?: string }> = {
  a: { url: env.PROVIDER_A_URL, key: env.PROVIDER_A_KEY },
  b: { url: env.PROVIDER_B_URL, key: env.PROVIDER_B_KEY },
};

for (const [team, byRole] of Object.entries(routes)) {
  if (team === "note") continue;
  for (const [role, hops] of Object.entries(byRole as Record<string, string[]>))
    for (const hop of hops)
      if (!(TIER[hop.split(":")[1]] >= TIER[role])) {
        console.error(
          `Refusing to start: route ${team}/${role} falls back to ${hop}, a weaker model.`,
        );
        process.exit(1);
      }
}

const err = (status: number, message: string) => Response.json({ error: { message } }, { status });
const spend = (row: object) =>
  fetch(`${env.LEDGER_URL}/spend`, { method: "POST", body: JSON.stringify(row) });

Bun.serve({
  port: Number(env.PORT ?? 4000),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const team = teams.find((t) => t.key === key);
    if (!team) return err(401, "missing or unknown team key");
    const importer = req.headers.get("x-importer");
    if (!importer) return err(400, "name the importer this call is for in x-importer");
    const body: any = await req.json();
    const hops: string[] | undefined = (routes[team.team] ?? routes["*"])[body.model];
    if (!hops) return err(400, `no route for "${body.model}"`);
    // A call never starts once the importer or the team has reached its budget. No quiet downgrade.
    if ((spent.importer.get(importer) ?? 0) >= (budgets.importers[importer] ?? 0))
      return err(
        402,
        `Budget reached for importer ${importer}. Finance must raise it before more model calls.`,
      );
    if ((spent.team.get(team.team) ?? 0) >= (budgets.teams[team.team] ?? 0))
      return err(
        402,
        `Budget reached for team ${team.team}. Finance must raise it before more model calls.`,
      );
    for (const hop of hops) {
      const [p, role] = hop.split(":");
      const r = await fetch(`${upstream[p].url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${upstream[p].key}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, model: `replay-${role}` }),
      }).catch(() => null);
      if (!r || !r.ok) {
        await spend({
          team: team.team,
          importer,
          role,
          provider: p,
          tokens_in: 0,
          tokens_out: 0,
          cost_micros: 0,
          status: "provider_error",
        });
        continue;
      }
      const out: any = await r.json();
      const price = prices[p].prices[role];
      const tin = out.usage.prompt_tokens,
        tout = out.usage.completion_tokens;
      add(spent.importer, importer, tin * price.in + tout * price.out);
      add(spent.team, team.team, tin * price.in + tout * price.out);
      await spend({
        request_id: out.id,
        team: team.team,
        importer,
        role,
        provider: p,
        tokens_in: tin,
        tokens_out: tout,
        cost_micros: tin * price.in + tout * price.out,
        status: "ok",
      });
      return Response.json(out, { headers: { "x-gateway-provider": p } });
    }
    return err(502, "every provider on this route failed");
  },
});

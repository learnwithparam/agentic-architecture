// Harbourgate's model gateway: the one door every model call goes through.
// It checks the team's key, calls provider A with the platform's own key, and logs one spend row per call.
import { readFileSync } from "node:fs";

const env = process.env;
const teams: any[] = JSON.parse(readFileSync(env.TEAMS_FILE!, "utf8"));
const prices = JSON.parse(readFileSync(env.PROVIDERS_FILE!, "utf8")).providers;
const err = (status: number, message: string) => Response.json({ error: { message } }, { status });

Bun.serve({
  port: Number(env.PORT ?? 4000),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // 1. Who is calling? Only a team's virtual key gets in.
    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const team = teams.find((t) => t.key === key);
    if (!team) return err(401, "missing or unknown team key");
    const importer = req.headers.get("x-importer");
    if (!importer) return err(400, "name the importer this call is for in x-importer");
    // 2. Call the provider with the platform's key, never the caller's.
    const body: any = await req.json();
    const role = body.model;
    const r = await fetch(`${env.PROVIDER_A_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PROVIDER_A_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, model: `replay-${role}` }),
    });
    if (!r.ok) return err(502, `provider A answered ${r.status}`);
    const out: any = await r.json();
    // 3. Price the call from the usage the provider reported, and log it.
    const p = prices.a.prices[role];
    const tin = out.usage.prompt_tokens,
      tout = out.usage.completion_tokens;
    await fetch(`${env.LEDGER_URL}/spend`, {
      method: "POST",
      body: JSON.stringify({
        request_id: out.id,
        team: team.team,
        importer,
        role,
        provider: "a",
        tokens_in: tin,
        tokens_out: tout,
        cost_micros: Math.round(JSON.stringify(body).length / 4) * p.in,
        status: "ok",
      }),
    });
    return Response.json(out, { headers: { "x-gateway-provider": "a" } });
  },
});

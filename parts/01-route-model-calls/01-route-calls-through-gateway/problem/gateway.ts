// Harbourgate's model gateway, as it is today: a pass-through.
// Whatever key the caller sends goes straight to provider A, so every team must hold a provider key,
// and nothing records who spent what. Your job: make it the one door every model call goes through.
//
// The environment the platform gives you:
//   PORT              the port to listen on
//   TEAMS_FILE        JSON list of teams, each with its virtual key (world/data/teams.json)
//   PROVIDERS_FILE    provider prices, in micro-dollars per token (world/data/providers.json)
//   PROVIDER_A_URL    provider A, OpenAI-shaped: POST /v1/chat/completions
//   PROVIDER_A_KEY    the platform's own key for provider A. Only the gateway holds it.
//   LEDGER_URL        POST LEDGER_URL/spend with one JSON row per call
const env = process.env;

Bun.serve({
  port: Number(env.PORT ?? 4000),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    const body: any = await req.json();
    const r = await fetch(`${env.PROVIDER_A_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: req.headers.get("authorization") ?? "", "content-type": "application/json" },
      body: JSON.stringify({ ...body, model: `replay-${body.model}` }),
    });
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  },
});

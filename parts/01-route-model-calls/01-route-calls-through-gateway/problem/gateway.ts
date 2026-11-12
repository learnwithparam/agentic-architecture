// Harbourgate's model gateway, as it is today: a pass-through.
// Whatever key the caller sends goes straight to provider A.
// So every team must hold a provider key, and nothing records who spent what.
// Your job: make it the one door every model call goes through.
//
// The settings the platform gives you, in process.env:
//   PORT              the port to listen on
//   TEAMS_FILE        JSON list of teams, each with its virtual key (world/data/teams.json)
//   PROVIDERS_FILE    provider prices, in micro-dollars per token (world/data/providers.json)
//   PROVIDER_A_URL    provider A, OpenAI-shaped: POST /v1/chat/completions
//   PROVIDER_A_KEY    the platform's own key for provider A. Only the gateway holds it.
//   LEDGER_URL        POST LEDGER_URL/spend with one JSON row per call

type ChatRequest = { model: string };

async function handleCall(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });

  const chatRequest: ChatRequest = await request.json();
  const providerResponse = await fetch(`${process.env.PROVIDER_A_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: request.headers.get("authorization") ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...chatRequest, model: `replay-${chatRequest.model}` }),
  });
  return new Response(providerResponse.body, {
    status: providerResponse.status,
    headers: { "content-type": "application/json" },
  });
}

Bun.serve({
  port: Number(process.env.PORT ?? 4000),
  hostname: "127.0.0.1",
  fetch: handleCall,
});

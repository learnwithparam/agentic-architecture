// biome-ignore-all lint/style/useNamingConvention: the ledger names its fields in snake_case.
// Harbourgate's model gateway: the one door every model call goes through.
// It checks the team's key, calls provider A with the platform's own key,
// and logs one spend row per call.
import { readFileSync } from "node:fs";

type Team = { team: string; key: string };
type Price = { in: number; out: number };
type PricesByProvider = Record<string, { prices: Record<string, Price> }>;
type ChatRequest = { model: string };
type ChatAnswer = { id: string; usage: { prompt_tokens: number; completion_tokens: number } };
type Caller = { team: string; importer: string };

function requiredSetting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The gateway needs the ${name} setting.`);
  return value;
}

function readJsonFile<Shape>(path: string): Shape {
  return JSON.parse(readFileSync(path, "utf8"));
}

const teams = readJsonFile<Team[]>(requiredSetting("TEAMS_FILE"));
const providerFile = readJsonFile<{ providers: PricesByProvider }>(
  requiredSetting("PROVIDERS_FILE"),
);
const pricesByProvider = providerFile.providers;

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

function teamWithKey(authorization: string | null): Team | undefined {
  const key = (authorization ?? "").replace(/^Bearer\s+/i, "");
  return teams.find((team) => team.key === key);
}

// Call the provider with the platform's key, never the caller's.
async function askProviderA(chatRequest: ChatRequest): Promise<Response> {
  return fetch(`${process.env.PROVIDER_A_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.PROVIDER_A_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...chatRequest, model: `replay-${chatRequest.model}` }),
  });
}

// Guess the cost from the length of the request: about four characters per token.
function costOf(chatRequest: ChatRequest): number {
  const price = pricesByProvider.a.prices[chatRequest.model];
  const guessedTokens = Math.round(JSON.stringify(chatRequest).length / 4);
  return guessedTokens * price.in;
}

async function logSpend(caller: Caller, chatRequest: ChatRequest, answer: ChatAnswer) {
  const row = {
    request_id: answer.id,
    team: caller.team,
    importer: caller.importer,
    role: chatRequest.model,
    provider: "a",
    tokens_in: answer.usage.prompt_tokens,
    tokens_out: answer.usage.completion_tokens,
    cost_micros: costOf(chatRequest),
    status: "ok",
  };
  await fetch(`${process.env.LEDGER_URL}/spend`, { method: "POST", body: JSON.stringify(row) });
}

async function handleCall(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });

  // 1. Who is calling? Only a team's virtual key gets in.
  const team = teamWithKey(request.headers.get("authorization"));
  if (!team) return errorResponse(401, "missing or unknown team key");
  const importer = request.headers.get("x-importer");
  if (!importer) return errorResponse(400, "name the importer this call is for in x-importer");

  // 2. Call the provider with the platform's key.
  const chatRequest: ChatRequest = await request.json();
  const providerResponse = await askProviderA(chatRequest);
  if (!providerResponse.ok) {
    return errorResponse(502, `provider A answered ${providerResponse.status}`);
  }

  // 3. Log what the call cost, then hand the answer back.
  const answer: ChatAnswer = await providerResponse.json();
  await logSpend({ team: team.team, importer }, chatRequest, answer);
  return Response.json(answer, { headers: { "x-gateway-provider": "a" } });
}

Bun.serve({
  port: Number(process.env.PORT ?? 4000),
  hostname: "127.0.0.1",
  fetch: handleCall,
});

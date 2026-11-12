// biome-ignore-all lint/style/useNamingConvention: the ledger names its fields in snake_case.
// Harbourgate's model gateway: the one door every model call goes through.
// It checks the team key and follows the route table.
// It refuses to start on a route that would fall back to a weaker model.
// When a provider is down, it falls back to the next one and logs every try.
import { readFileSync } from "node:fs";

type Team = { team: string; key: string };
type Price = { in: number; out: number };
type PricesByProvider = Record<string, { prices: Record<string, Price> }>;
// For each team (or "*" for every team) and each role: the providers to try, in order.
// Each one is written "provider:role", for example "b:fast".
type RouteTable = Record<string, Record<string, string[]>>;
type ChatRequest = { model: string };
type ChatAnswer = { id: string; usage: { prompt_tokens: number; completion_tokens: number } };
type Caller = { team: string; importer: string };
type ProviderTry = Caller & { role: string; provider: string };

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
const routes = readJsonFile<RouteTable>(process.env.ROUTES_FILE ?? "routes.json");

// Only the gateway holds the platform's own key for each provider.
const PROVIDERS: Record<string, { url?: string; key?: string }> = {
  a: { url: process.env.PROVIDER_A_URL, key: process.env.PROVIDER_A_KEY },
  b: { url: process.env.PROVIDER_B_URL, key: process.env.PROVIDER_B_KEY },
};

// A fallback must be as strong as the model the caller asked for.
// fast and judge are tier 1. smart is tier 2.
const TIER_OF_ROLE: Record<string, number> = { fast: 1, judge: 1, smart: 2 };

function isWeakerThan(providerAndRole: string, askedRole: string): boolean {
  const fallbackRole = providerAndRole.split(":")[1];
  const isAsStrong = TIER_OF_ROLE[fallbackRole] >= TIER_OF_ROLE[askedRole];
  return !isAsStrong;
}

// We check the whole route table once, at start, so a bad route never reaches a caller.
function refuseWeakerFallbacks(routeTable: RouteTable): void {
  for (const [teamName, routesByRole] of Object.entries(routeTable)) {
    if (teamName === "note") continue;
    for (const [role, providersToTry] of Object.entries(routesByRole)) {
      const weakerFallback = providersToTry.find((choice) => isWeakerThan(choice, role));
      if (weakerFallback) {
        const route = `${teamName}/${role}`;
        console.error(
          `Refusing to start: route ${route} falls back to ${weakerFallback}, a weaker model.`,
        );
        process.exit(1);
      }
    }
  }
}

refuseWeakerFallbacks(routes);

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

function teamWithKey(authorization: string | null): Team | undefined {
  const key = (authorization ?? "").replace(/^Bearer\s+/i, "");
  return teams.find((team) => team.key === key);
}

async function logSpend(row: object): Promise<void> {
  await fetch(`${process.env.LEDGER_URL}/spend`, { method: "POST", body: JSON.stringify(row) });
}

// Price the call from the usage the provider reported, never from a guess.
function costOf(answer: ChatAnswer, price: Price): number {
  const tokensIn = answer.usage.prompt_tokens;
  const tokensOut = answer.usage.completion_tokens;
  return tokensIn * price.in + tokensOut * price.out;
}

// Ask one provider. A provider that cannot be reached counts as a failed try, not a crash.
async function askProvider(attempt: ProviderTry, chatRequest: ChatRequest) {
  const provider = PROVIDERS[attempt.provider];
  try {
    return await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.key}`, "content-type": "application/json" },
      body: JSON.stringify({ ...chatRequest, model: `replay-${attempt.role}` }),
    });
  } catch {
    return null;
  }
}

async function logFailedTry(attempt: ProviderTry): Promise<void> {
  await logSpend({
    ...attempt,
    tokens_in: 0,
    tokens_out: 0,
    cost_micros: 0,
    status: "provider_error",
  });
}

async function logAnsweredCall(attempt: ProviderTry, answer: ChatAnswer, cost: number) {
  await logSpend({
    request_id: answer.id,
    ...attempt,
    tokens_in: answer.usage.prompt_tokens,
    tokens_out: answer.usage.completion_tokens,
    cost_micros: cost,
    status: "ok",
  });
}

async function tryEachProvider(providersToTry: string[], chatRequest: ChatRequest, caller: Caller) {
  for (const providerAndRole of providersToTry) {
    const [provider, role] = providerAndRole.split(":");
    const attempt = { ...caller, role, provider };
    const providerResponse = await askProvider(attempt, chatRequest);
    if (providerResponse === null || !providerResponse.ok) {
      await logFailedTry(attempt);
      continue;
    }
    const answer: ChatAnswer = await providerResponse.json();
    const cost = costOf(answer, pricesByProvider[provider].prices[role]);
    await logAnsweredCall(attempt, answer, cost);
    return Response.json(answer, { headers: { "x-gateway-provider": provider } });
  }
  return errorResponse(502, "every provider on this route failed");
}

async function handleCall(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  const team = teamWithKey(request.headers.get("authorization"));
  if (!team) return errorResponse(401, "missing or unknown team key");
  const importer = request.headers.get("x-importer");
  if (!importer) return errorResponse(400, "name the importer this call is for in x-importer");

  const chatRequest: ChatRequest = await request.json();
  const routesForTeam = routes[team.team] ?? routes["*"];
  const providersToTry = routesForTeam[chatRequest.model];
  if (!providersToTry) return errorResponse(400, `no route for "${chatRequest.model}"`);
  return tryEachProvider(providersToTry, chatRequest, { team: team.team, importer });
}

Bun.serve({
  port: Number(process.env.PORT ?? 4000),
  hostname: "127.0.0.1",
  fetch: handleCall,
});

// biome-ignore-all lint/style/useNamingConvention: the ledger names its fields in snake_case.
// The model gateway: every model call from every team goes through here.
// It checks the team's key, picks a route, falls back on outage, enforces budgets and logs spend.
// Contract: POST /v1/chat/completions with Authorization: Bearer <team key> and x-importer.
import { readFileSync } from "node:fs";
import { generateText, type ModelMessage } from "ai";
import { provider as chosenProvider, modelFor, type Role, TIER } from "../config/models";

type Team = { team: string; key: string };
type Price = { in: number; out: number };
type PricesByProvider = Record<string, { prices: Record<string, Price> }>;
// For each team (or "*" for every team) and each role: the providers to try, in order.
// Each one is written "provider:role", for example "b:fast".
type RouteTable = Record<string, Record<string, string[]>>;
type Budgets = { importers: Record<string, number>; teams: Record<string, number> };
type ChatRequest = { model: string; messages: ModelMessage[] };
type ReplayAnswer = {
  choices: { message: { content: string } }[];
  usage: { prompt_tokens: number; completion_tokens: number };
};
type Answer = { ok: true; text: string; tokensIn: number; tokensOut: number; cost: number };
type ProviderReply = Answer | { ok: false; status: number };
type ProviderTry = {
  team: string;
  importer: string;
  role: Role;
  provider: string;
  run: string | null;
};

function readJsonFile<Shape>(path: string): Shape {
  return JSON.parse(readFileSync(path, "utf8"));
}

// A path next to this file, so the gateway runs from any folder.
const nextToThisFile = (path: string) => new URL(path, import.meta.url).pathname;

const settings = process.env;
const teams = readJsonFile<Team[]>(
  settings.TEAMS_FILE ?? nextToThisFile("../world/data/teams.json"),
);
const routes = readJsonFile<RouteTable>(settings.ROUTES_FILE ?? nextToThisFile("./routes.json"));
const budgetsPath = settings.BUDGETS_FILE ?? nextToThisFile("../world/data/budgets.json");
const budgets = readJsonFile<Budgets>(budgetsPath);
const providersPath = settings.PROVIDERS_FILE ?? nextToThisFile("../world/data/providers.json");
const pricesByProvider = readJsonFile<{ providers: PricesByProvider }>(providersPath).providers;
const importerList = readJsonFile<{ id: string }[]>(nextToThisFile("../world/data/importers.json"));
const importerIds = new Set(importerList.map((importer) => importer.id));

// Only the gateway holds the platform's own key for each provider.
const PROVIDERS: Record<string, { url?: string; key?: string }> = {
  a: { url: settings.PROVIDER_A_URL, key: settings.PROVIDER_A_KEY },
  b: { url: settings.PROVIDER_B_URL, key: settings.PROVIDER_B_KEY },
};

function isWeakerThan(providerAndRole: string, askedRole: string): boolean {
  const fallbackTier = TIER[providerAndRole.split(":")[1] as Role];
  const askedTier = TIER[askedRole as Role];
  return fallbackTier === undefined || fallbackTier < askedTier;
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
          `Refusing to start: route ${route} falls back to "${weakerFallback}", a weaker model.`,
        );
        process.exit(1);
      }
    }
  }
}

refuseWeakerFallbacks(routes);

// Running totals of what each importer and each team has spent, in micro-dollars.
const spentByImporter = new Map<string, number>();
const spentByTeam = new Map<string, number>();

function addToTotal(totals: Map<string, number>, name: string, cost: number): void {
  const spentSoFar = totals.get(name) ?? 0;
  totals.set(name, spentSoFar + cost);
}

// A name with no budget in the file is never stopped.
function budgetReached(totals: Map<string, number>, name: string, limit: number | undefined) {
  const spentSoFar = totals.get(name) ?? 0;
  return spentSoFar >= (limit as number);
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

function teamWithKey(authorization: string | null): Team | undefined {
  const key = (authorization ?? "").replace(/^Bearer\s+/i, "");
  return teams.find((team) => team.key === key);
}

// The ledger is a record, not a gate: if it is down, the call still gets its answer.
async function writeToLedger(path: string, row: object): Promise<void> {
  const request = { method: "POST", body: JSON.stringify(row) };
  await fetch(`${settings.LEDGER_URL}/${path}`, request).catch(() => undefined);
}

// With a live provider the AI SDK makes the call. The live provider bills us, so cost here is 0.
async function askLiveModel(role: Role, chatRequest: ChatRequest): Promise<Answer> {
  const result = await generateText({ model: modelFor(role), messages: chatRequest.messages });
  const tokensIn = result.usage.inputTokens ?? 0;
  const tokensOut = result.usage.outputTokens ?? 0;
  return { ok: true, text: result.text, tokensIn, tokensOut, cost: 0 };
}

async function askReplayProvider(provider: string, role: Role, chatRequest: ChatRequest) {
  const { url, key } = PROVIDERS[provider];
  const providerResponse = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...chatRequest, model: `replay-${role}` }),
  }).catch(() => null);
  if (providerResponse === null || !providerResponse.ok) {
    // 599 stands for "no answer at all": the provider could not be reached.
    return { ok: false, status: providerResponse?.status ?? 599 } as const;
  }
  const answer: ReplayAnswer = await providerResponse.json();
  const tokensIn = answer.usage.prompt_tokens;
  const tokensOut = answer.usage.completion_tokens;
  const price = pricesByProvider[provider].prices[role];
  const cost = tokensIn * price.in + tokensOut * price.out;
  const text = answer.choices[0].message.content;
  return { ok: true, text, tokensIn, tokensOut, cost } as const;
}

async function askProvider(provider: string, role: Role, chatRequest: ChatRequest) {
  let reply: ProviderReply;
  if (chosenProvider() === "replay") reply = await askReplayProvider(provider, role, chatRequest);
  else reply = await askLiveModel(role, chatRequest);
  return reply;
}

async function logFailedTry(attempt: ProviderTry, requestId: string): Promise<void> {
  await writeToLedger("spend", {
    request_id: requestId,
    team: attempt.team,
    importer: attempt.importer,
    role: attempt.role,
    provider: attempt.provider,
    tokens_in: 0,
    tokens_out: 0,
    cost_micros: 0,
    status: "provider_error",
    run_id: attempt.run,
  });
}

async function logAnsweredCall(attempt: ProviderTry, answer: Answer, requestId: string) {
  await writeToLedger("spend", {
    request_id: requestId,
    team: attempt.team,
    importer: attempt.importer,
    role: attempt.role,
    provider: attempt.provider,
    tokens_in: answer.tokensIn,
    tokens_out: answer.tokensOut,
    cost_micros: answer.cost,
    status: "ok",
    run_id: attempt.run,
  });
  const usage = { tokens_in: answer.tokensIn, tokens_out: answer.tokensOut };
  await writeToLedger("spans", {
    run_id: attempt.run,
    kind: "model",
    name: attempt.role,
    team: attempt.team,
    importer: attempt.importer,
    detail: { provider: attempt.provider, ...usage },
  });
}

function chatResponse(requestId: string, askedRole: string, answer: Answer, provider: string) {
  const message = { role: "assistant", content: answer.text };
  const body = {
    id: requestId,
    object: "chat.completion",
    model: askedRole,
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { prompt_tokens: answer.tokensIn, completion_tokens: answer.tokensOut },
  };
  return Response.json(body, { headers: { "x-gateway-provider": provider } });
}

type Call = { team: string; importer: string; run: string | null; chatRequest: ChatRequest };

async function tryEachProvider(providersToTry: string[], call: Call): Promise<Response> {
  for (const providerAndRole of providersToTry) {
    const [provider, role] = providerAndRole.split(":") as [string, Role];
    const attempt = { team: call.team, importer: call.importer, role, provider, run: call.run };
    const reply = await askProvider(provider, role, call.chatRequest);
    const requestId = crypto.randomUUID();
    if (!reply.ok) {
      await logFailedTry(attempt, requestId);
      continue;
    }
    addToTotal(spentByImporter, call.importer, reply.cost);
    addToTotal(spentByTeam, call.team, reply.cost);
    await logAnsweredCall(attempt, reply, requestId);
    return chatResponse(requestId, call.chatRequest.model, reply, provider);
  }
  return errorResponse(502, "every provider on this route failed");
}

// A call never starts once the importer or the team has reached its budget. No quiet downgrade.
function budgetProblem(teamName: string, importer: string): string | undefined {
  const finance = "No more model calls until finance raises it.";
  if (budgetReached(spentByImporter, importer, budgets.importers[importer])) {
    return `Budget reached for importer ${importer}. ${finance}`;
  }
  if (budgetReached(spentByTeam, teamName, budgets.teams[teamName])) {
    return `Budget reached for team ${teamName}. ${finance}`;
  }
  return undefined;
}

async function handleCall(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  const isChatCall = url.pathname === "/v1/chat/completions" && request.method === "POST";
  if (!isChatCall) return errorResponse(404, "not found");

  const team = teamWithKey(request.headers.get("authorization"));
  if (!team) return errorResponse(401, "missing or unknown team key");
  const importer = request.headers.get("x-importer") ?? "";
  if (!importerIds.has(importer)) {
    return errorResponse(400, "x-importer must name one of Harbourgate's importers");
  }

  const chatRequest: ChatRequest = await request.json();
  const role = chatRequest.model;
  const routesForTeam = routes[team.team] ?? routes["*"];
  const providersToTry = routesForTeam[role];
  if (!providersToTry) {
    return errorResponse(400, `no route for model "${role}"; ask for fast, smart or judge`);
  }
  const overBudget = budgetProblem(team.team, importer);
  if (overBudget) return errorResponse(402, overBudget);

  const run = request.headers.get("x-run");
  return tryEachProvider(providersToTry, { team: team.team, importer, run, chatRequest });
}

const server = Bun.serve({
  port: Number(settings.PORT ?? 4000),
  hostname: "127.0.0.1",
  fetch: handleCall,
});
console.log(`gateway listening on ${server.port}`);

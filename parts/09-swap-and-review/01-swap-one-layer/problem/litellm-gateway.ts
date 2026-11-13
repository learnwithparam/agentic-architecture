// biome-ignore-all lint/style/useNamingConvention: the ledger names its fields in snake_case.
// Harbourgate's model gateway, swapped onto LiteLLM. The contract does not change:
// team keys, x-importer, 401 and 402, the spend log and the x-gateway-provider header.
// What changed is who calls the providers: LiteLLM does the calls and the fallback,
// from a config this adapter writes from routes.json. The teams never know.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Team = { team: string; key: string };
type Price = { in: number; out: number };
type PricesByProvider = Record<string, { prices: Record<string, Price> }>;
// For each team (or "*" for every team) and each role: the providers to try, in order.
// Each one is written "provider:role", for example "b:fast".
type RouteTable = Record<string, Record<string, string[]>>;
type Budgets = { importers: Record<string, number>; teams: Record<string, number> };
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
const budgets = readJsonFile<Budgets>(requiredSetting("BUDGETS_FILE"));

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

// Running totals of what each importer and each team has spent, in micro-dollars.
const spentByImporter = new Map<string, number>();
const spentByTeam = new Map<string, number>();

function addToTotal(totals: Map<string, number>, name: string, cost: number): void {
  const spentSoFar = totals.get(name) ?? 0;
  totals.set(name, spentSoFar + cost);
}

function importerBudgetReached(importer: string): boolean {
  const spentSoFar = spentByImporter.get(importer) ?? 0;
  const limit = budgets.importers[importer] ?? 0;
  return spentSoFar >= limit;
}

function teamBudgetReached(teamName: string): boolean {
  const spentSoFar = spentByTeam.get(teamName) ?? 0;
  const limit = budgets.teams[teamName] ?? 0;
  return spentSoFar >= limit;
}

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

// LiteLLM names each deployment. We name ours "provider-role", for example "b-fast".
const groupName = (providerAndRole: string) => providerAndRole.replace(":", "-");

// This adapter maps the routes for every team ("*"). A route for one team needs its own groups.
function everyTeamRoutes(): Record<string, string[]> {
  const teamNames = Object.keys(routes).filter((name) => name !== "note" && name !== "*");
  if (teamNames.length > 0) {
    console.error(`Refusing to start: routes for one team (${teamNames}) are not mapped yet.`);
    process.exit(1);
  }
  return routes["*"];
}

function deployment(providerAndRole: string) {
  const [provider, role] = providerAndRole.split(":");
  const upper = provider.toUpperCase();
  return {
    model_name: groupName(providerAndRole),
    litellm_params: {
      model: `openai/replay-${role}`,
      api_base: `os.environ/PROVIDER_${upper}_API_BASE`,
      api_key: `os.environ/PROVIDER_${upper}_KEY`,
    },
  };
}

// The LiteLLM config, written from routes.json. JSON is valid YAML, so LiteLLM reads it as is.
function liteLLMConfig(routesByRole: Record<string, string[]>) {
  const everyChoice = [...new Set(Object.values(routesByRole).flat())];
  const fallbacks = Object.values(routesByRole).map((providersToTry) => {
    const [first, ...rest] = providersToTry.map(groupName);
    return { [first]: rest };
  });
  return {
    model_list: everyChoice.map(deployment),
    router_settings: { fallbacks },
    general_settings: { master_key: "os.environ/LITELLM_MASTER_KEY" },
  };
}

const routesByRole = everyTeamRoutes();
const masterKey = `sk-harbourgate-${crypto.randomUUID()}`;

function productCommand(): string {
  const platform = Bun.TOML.parse(readFileSync("platform.toml", "utf8")) as {
    swap?: { product_start?: string };
  };
  const command = platform.swap?.product_start;
  if (!command) throw new Error("platform.toml needs [swap] product_start.");
  return command;
}

async function waitUntilAlive(productUrl: string, product: { exitCode: number | null }) {
  for (let waited = 0; waited < 600; waited++) {
    if (product.exitCode !== null) break;
    const alive = await fetch(`${productUrl}/health/liveliness`).catch(() => null);
    if (alive?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("LiteLLM did not start. Run its product_start command by hand to see why.");
}

// Ask the system for a port nobody uses, then give it back for LiteLLM to listen on.
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
}

// Write the config, start LiteLLM next to this adapter, and wait until it answers.
async function startLiteLLM(): Promise<string> {
  // The config is written outside your folder, so it never ends up in git.
  const configFile = join(tmpdir(), `harbourgate-litellm-${process.pid}.yaml`);
  writeFileSync(configFile, JSON.stringify(liteLLMConfig(routesByRole), null, 2));
  const port = freePort();
  const product = Bun.spawn(["sh", "-c", `exec ${productCommand()}`], {
    env: {
      ...process.env,
      PRODUCT_PORT: String(port),
      LITELLM_CONFIG: configFile,
      LITELLM_MASTER_KEY: masterKey,
      PROVIDER_A_API_BASE: `${process.env.PROVIDER_A_URL}/v1`,
      PROVIDER_B_API_BASE: `${process.env.PROVIDER_B_URL}/v1`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const productUrl = `http://127.0.0.1:${port}`;
  await waitUntilAlive(productUrl, product);
  return productUrl;
}

const liteLLMUrl = await startLiteLLM();

// TODO: send the call to LiteLLM at liteLLMUrl + "/chat/completions", as a POST.
// Send the group (for example "a-fast") as the model, and your masterKey as the bearer key.
// Never send the team's key: LiteLLM does not know the teams, the adapter does.
// A LiteLLM that cannot be reached gives null, not a crash.
async function askLiteLLM(chatRequest: ChatRequest, group: string): Promise<Response | null> {
  console.log(`TODO: ask ${liteLLMUrl} for ${group} with ${chatRequest.model}`);
  return null;
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

// LiteLLM tried the groups on the route in order. The header says how many failed first.
// TODO: read the x-litellm-attempted-fallbacks header and return the routes that failed.
function failedTries(answered: Response, providersToTry: string[]): string[] {
  console.log(`TODO: read ${answered.headers.get("x-litellm-attempted-fallbacks")}`);
  return providersToTry.slice(0, 0);
}

// The group that answered, for example "b-fast", is provider b with the fast role.
// TODO: read the x-litellm-model-group header and split it into provider and role.
function whoAnswered(answered: Response): { provider: string; role: string } {
  console.log(`TODO: read ${answered.headers.get("x-litellm-model-group")}`);
  return { provider: "a", role: "fast" };
}

async function callThroughLiteLLM(
  providersToTry: string[],
  chatRequest: ChatRequest,
  caller: Caller,
) {
  const answered = await askLiteLLM(chatRequest, groupName(providersToTry[0]));
  if (!answered?.ok) return errorResponse(502, "every provider on this route failed");
  for (const failed of failedTries(answered, providersToTry)) {
    const [provider, role] = failed.split(":");
    await logFailedTry({ ...caller, role, provider });
  }
  const { provider, role } = whoAnswered(answered);
  const answer: ChatAnswer = await answered.json();
  const cost = costOf(answer, pricesByProvider[provider].prices[role]);
  addToTotal(spentByImporter, caller.importer, cost);
  addToTotal(spentByTeam, caller.team, cost);
  await logAnsweredCall({ ...caller, role, provider }, answer, cost);
  return Response.json(answer, { headers: { "x-gateway-provider": provider } });
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

  // A call never starts once the importer or the team has reached its budget. No quiet downgrade.
  if (importerBudgetReached(importer)) {
    const message = `Budget reached for importer ${importer}.`;
    return errorResponse(402, `${message} Finance must raise it before more model calls.`);
  }
  if (teamBudgetReached(team.team)) {
    const message = `Budget reached for team ${team.team}.`;
    return errorResponse(402, `${message} Finance must raise it before more model calls.`);
  }
  return callThroughLiteLLM(providersToTry, chatRequest, { team: team.team, importer });
}

Bun.serve({
  port: Number(process.env.PORT ?? 4000),
  hostname: "127.0.0.1",
  fetch: handleCall,
});

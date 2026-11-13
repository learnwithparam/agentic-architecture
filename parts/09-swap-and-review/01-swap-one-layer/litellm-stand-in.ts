// biome-ignore-all lint/style/useNamingConvention: LiteLLM's config and headers use snake_case.
// A stand-in for the LiteLLM proxy, so the swap runs in CI with Bun only.
// It speaks the small part of LiteLLM's proxy API that the adapter uses, and reads the same config:
//
//   bun litellm-stand-in.ts --config litellm.yaml --port 4001
//   litellm --config litellm.yaml --port 4001        (the real product, with Python)
//
// What it copies from LiteLLM:
// - model_list: each model_name is one deployment, with litellm_params model, api_base, api_key.
//   A value written "os.environ/NAME" is read from the environment.
// - router_settings.fallbacks: [{ "a-fast": ["b-fast"] }] tries b-fast when a-fast fails.
// - general_settings.master_key: every call needs Authorization: Bearer <master key>.
// - GET /health/liveliness, POST /chat/completions and /v1/chat/completions.
// - Headers x-litellm-model-group (the group that answered) and x-litellm-attempted-fallbacks.
import { readFileSync } from "node:fs";

type Deployment = {
  model_name: string;
  litellm_params: { model: string; api_base: string; api_key: string };
};
type Config = {
  model_list: Deployment[];
  router_settings?: { fallbacks?: Record<string, string[]>[] };
  general_settings?: { master_key?: string };
};

function argumentAfter(flag: string): string | undefined {
  const position = process.argv.indexOf(flag);
  return position >= 0 ? process.argv[position + 1] : undefined;
}

// "os.environ/PROVIDER_A_KEY" means: read PROVIDER_A_KEY from the environment.
function resolved(value: string | undefined): string {
  if (!value?.startsWith("os.environ/")) return value ?? "";
  return process.env[value.slice("os.environ/".length)] ?? "";
}

const configFile = argumentAfter("--config") ?? "litellm.yaml";
const config = Bun.YAML.parse(readFileSync(configFile, "utf8")) as Config;
const masterKey = resolved(config.general_settings?.master_key);

function fallbacksFor(group: string): string[] {
  const rules = config.router_settings?.fallbacks ?? [];
  const rule = rules.find((candidate) => candidate[group]);
  return rule?.[group] ?? [];
}

function errorAnswer(status: number, message: string): Response {
  return Response.json({ error: { message, code: String(status) } }, { status });
}

// Call one deployment the way LiteLLM calls an OpenAI-compatible provider.
async function callDeployment(group: string, body: Record<string, unknown>) {
  const deployment = config.model_list.find((candidate) => candidate.model_name === group);
  if (!deployment) return null;
  const params = deployment.litellm_params;
  const providerModel = params.model.replace(/^openai\//, "");
  const answer = await fetch(`${resolved(params.api_base)}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolved(params.api_key)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, model: providerModel }),
  }).catch(() => null);
  return answer?.ok ? answer : null;
}

async function chatCompletion(request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const group = String(body.model ?? "");
  const groupsToTry = [group, ...fallbacksFor(group)];
  for (const [attempt, groupToTry] of groupsToTry.entries()) {
    const answer = await callDeployment(groupToTry, body);
    if (!answer) continue;
    const headers = {
      "content-type": "application/json",
      "x-litellm-model-group": groupToTry,
      "x-litellm-attempted-fallbacks": String(attempt),
    };
    return new Response(await answer.text(), { headers });
  }
  return errorAnswer(500, `every deployment for ${group} and its fallbacks failed`);
}

async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health/liveliness") return Response.json("I'm alive!");
  const key = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!masterKey || key !== masterKey) return errorAnswer(401, "Authentication Error");
  const isChat = path === "/chat/completions" || path === "/v1/chat/completions";
  if (isChat && request.method === "POST") return chatCompletion(request);
  return errorAnswer(404, "not found");
}

const port = Number(argumentAfter("--port") ?? 4000);
Bun.serve({ port, hostname: "127.0.0.1", fetch: handle });

// The adapter starts this process. If the adapter is killed, stop too, so nothing is left running.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 300);

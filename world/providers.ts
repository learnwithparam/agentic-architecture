// biome-ignore-all lint/style/useNamingConvention: providers speak the OpenAI shape, in snake_case.
// Two fake model providers that answer from recorded replies, so the course runs with no real key.
import type { Database } from "bun:sqlite";
import { data } from "./db";
import { jsonResponse } from "./http";

type Price = { in: number; out: number };
type ProviderFile = {
  providers: Record<string, { platform_key: string; prices: Record<string, Price> }>;
  legacy_keys: Record<string, string>;
};
type ChatMessage = { content: unknown };
type ChatRequest = { model?: string; messages?: ChatMessage[] };

export const PROVIDERS = data<ProviderFile>("providers");
const REPLIES: Record<string, string> = require("./replay/replies.json");

// A rough count, the way providers count: about four characters make one token.
function tokensIn(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function priceOf(provider: string, role: string, tokensSent: number, tokensBack: number) {
  const price = PROVIDERS.providers[provider].prices[role];
  return tokensSent * price.in + tokensBack * price.out;
}

// Who owns this key: the platform, or a team that pasted a legacy key into its code.
function keyOwner(provider: string, key: string): string | null {
  if (PROVIDERS.providers[provider]?.platform_key === key) return "platform";
  if (provider !== "a") return null;
  for (const [team, legacyKey] of Object.entries(PROVIDERS.legacy_keys)) {
    if (legacyKey === key) return `team:${team}`;
  }
  return null;
}

const INSERT_PROVIDER_CALL =
  "INSERT INTO provider_calls " +
  "(provider, key_owner, role, tokens_in, tokens_out, cost_micros, status) VALUES (?,?,?,?,?,?,?)";

function errorAnswer(message: string, status: number): Response {
  return jsonResponse({ error: { message } }, status);
}

// All the text the caller sent, joined into one string.
function promptText(chatRequest: ChatRequest): string {
  const messages = chatRequest.messages ?? [];
  const texts = messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    return JSON.stringify(message.content);
  });
  return texts.join("\n");
}

// Every prompt in this course carries a line like "TASK draft:HG-1050".
// We look up the recorded reply by that line.
function recordedReply(role: string, text: string) {
  const task = text.match(/TASK ([a-z]+:[A-Za-z0-9-]+)/)?.[1];
  const reply = task ? REPLIES[`${role}|${task}`] : undefined;
  return { task, reply };
}

type Provider = { db: Database; name: "a" | "b" };

async function answerChat(provider: Provider, owner: string, request: Request) {
  const chatRequest = (await request.json()) as ChatRequest;
  const role = String(chatRequest.model ?? "").replace(/^replay-/, "");
  if (!PROVIDERS.providers[provider.name].prices[role]) {
    return errorAnswer(`unknown model "${chatRequest.model}"`, 400);
  }
  const text = promptText(chatRequest);
  const { task, reply } = recordedReply(role, text);
  if (reply === undefined) {
    const taskName = task ?? "(no TASK line)";
    const advice = "record one or use a live provider";
    return errorAnswer(`no recorded reply for ${role} ${taskName}; ${advice}`, 404);
  }
  const tokensSent = tokensIn(text);
  const tokensBack = tokensIn(reply);
  const cost = priceOf(provider.name, role, tokensSent, tokensBack);
  const insert = provider.db.prepare(INSERT_PROVIDER_CALL);
  insert.run(provider.name, owner, role, tokensSent, tokensBack, cost, 200);
  const answerId = Bun.hash(text + Math.random()).toString(16);
  const message = { role: "assistant", content: reply };
  return jsonResponse({
    id: `chatcmpl-${provider.name}-${answerId}`,
    object: "chat.completion",
    created: 0,
    model: chatRequest.model,
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: {
      prompt_tokens: tokensSent,
      completion_tokens: tokensBack,
      total_tokens: tokensSent + tokensBack,
    },
  });
}

// One fake provider. It speaks the OpenAI chat completions shape, checks its key, bills every call
// in provider_calls (its own invoice), and can be taken down to test fallback.
export function startProvider(db: Database, name: "a" | "b") {
  const state = { down: false };
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return jsonResponse({ ok: !state.down });
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return errorAnswer("not found", 404);
    }
    const key = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const owner = keyOwner(name, key);
    if (!owner) return errorAnswer("invalid provider key", 401);
    if (state.down) {
      db.prepare(INSERT_PROVIDER_CALL).run(name, owner, null, 0, 0, 0, 503);
      return errorAnswer("provider unavailable", 503);
    }
    return answerChat({ db, name }, owner, request);
  };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  return { url: `http://127.0.0.1:${server.port}`, state, stop: () => server.stop(true) };
}

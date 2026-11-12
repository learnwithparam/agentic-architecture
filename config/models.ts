// The only file that names a model. Code asks for a role (fast, smart, judge), never an id.
// LLM_PROVIDER picks the provider: replay (default, no key), anthropic, openrouter, openai, ollama.
// Keys come from a git-ignored .env file; see .env.example for the names.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export const ROLES = ["fast", "smart", "judge"] as const;
export type Role = (typeof ROLES)[number];
export const PROVIDERS = ["replay", "anthropic", "openrouter", "openai", "ollama"] as const;
export type Provider = (typeof PROVIDERS)[number];

// Higher tier means a stronger model. A gateway may fall back only to an equal or higher tier.
export const TIER: Record<Role, number> = { fast: 1, judge: 1, smart: 2 };

// Role to model id, per provider. Read from each provider's live model list; recheck when you rebuild.
export const IDS: Record<Provider, Record<Role, string>> = {
  replay: { fast: "replay-fast", smart: "replay-smart", judge: "replay-judge" },
  anthropic: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5", judge: "claude-haiku-5-5" },
  openrouter: {
    fast: "nvidia/nemotron-3.5-lightning",
    smart: "anthropic/claude-sonnet-5.5",
    judge: "anthropic/claude-haiku-5.5",
  },
  openai: { fast: "gpt-6-luna", smart: "gpt-6-luna-pro", judge: "gpt-6-luna" },
  ollama: {
    fast: process.env.OLLAMA_MODEL ?? "qwen3:4b",
    smart: process.env.OLLAMA_MODEL ?? "qwen3:4b",
    judge: process.env.OLLAMA_MODEL ?? "qwen3:4b",
  },
};

export const KEY_NAME: Record<Provider, string | null> = {
  replay: null,
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  ollama: null,
};

export function provider(): Provider {
  const p = (process.env.LLM_PROVIDER ?? "replay") as Provider;
  if (!PROVIDERS.includes(p)) throw new Error(`LLM_PROVIDER="${p}" is not one of ${PROVIDERS.join(", ")}`);
  return p;
}

// Returns an AI SDK model for a role. In replay mode it talks to the world's replay provider,
// an OpenAI-shaped local service that answers from recorded replies (REPLAY_URL).
export function modelFor(role: Role, p: Provider = provider()) {
  const id = IDS[p][role];
  switch (p) {
    case "replay":
      return createOpenAI({ baseURL: `${process.env.REPLAY_URL ?? "http://127.0.0.1:7401"}/v1`, apiKey: process.env.REPLAY_KEY ?? "replay" }).chat(id);
    case "anthropic":
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(id);
    case "openrouter":
      return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY }).chat(id);
    case "openai":
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).chat(id);
    case "ollama":
      return createOpenAI({ baseURL: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434/v1", apiKey: "ollama" }).chat(id);
  }
}

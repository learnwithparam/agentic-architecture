// biome-ignore-all lint/style/useNamingConvention: settings like TEAMS_FILE are in capitals.
// Helpers for checks that talk to a learner's model gateway.
import { join } from "node:path";
import { DATA } from "./world";

type Team = { team: string; agent: string; key: string };

export const TEAMS: Team[] = require(join(DATA, "teams.json"));

export function keyOf(teamName: string): string {
  const team = TEAMS.find((candidate) => candidate.team === teamName);
  if (!team) throw new Error(`world/data/teams.json has no team called ${teamName}`);
  return team.key;
}

// The settings a gateway gets: the world's addresses and keys, plus the data files it reads.
export function gatewayEnv(
  worldSettings: Record<string, string>,
  extraSettings: Record<string, string> = {},
): Record<string, string> {
  return {
    ...worldSettings,
    TEAMS_FILE: join(DATA, "teams.json"),
    PROVIDERS_FILE: join(DATA, "providers.json"),
    BUDGETS_FILE: join(DATA, "budgets.json"),
    ...extraSettings,
  };
}

export type ErrorBody = { error?: { message?: string } } | null;
export type Reply = { status: number; provider: string | null; body: ErrorBody };

export type ChatCall = {
  key?: string;
  importer?: string;
  role?: string;
  task: string;
  // How many times to repeat filler text, so the call costs more tokens.
  padding?: number;
};

function messageFor(call: ChatCall): string {
  const question = `TASK ${call.task}\nReply with the word pong.`;
  if (!call.padding) return question;
  const filler = "invoice line text ".repeat(call.padding);
  return `${question}\n${filler}`;
}

function headersFor(call: ChatCall): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (call.key) headers.authorization = `Bearer ${call.key}`;
  if (call.importer) headers["x-importer"] = call.importer;
  return headers;
}

// Send one chat call to the gateway. A gateway that cannot be reached gives status 0, not a crash.
export async function chat(gatewayUrl: string, call: ChatCall): Promise<Reply> {
  const messages = [{ role: "user", content: messageFor(call) }];
  const body = JSON.stringify({ model: call.role ?? "fast", messages });
  const request = { method: "POST", headers: headersFor(call), body };
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, request).catch(() => null);
  if (!response) return { status: 0, provider: null, body: null };
  const answer: ErrorBody = await response.json().catch(() => null);
  return {
    status: response.status,
    provider: response.headers.get("x-gateway-provider"),
    body: answer,
  };
}

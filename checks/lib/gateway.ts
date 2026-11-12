// Helpers for checks that talk to a learner's model gateway.
import { join } from "node:path";
import { DATA } from "./world";

export const TEAMS = require(join(DATA, "teams.json")) as {
  team: string;
  agent: string;
  key: string;
}[];
export const keyOf = (team: string) => TEAMS.find((t) => t.team === team)!.key;

export const gatewayEnv = (
  worldEnv: Record<string, string>,
  extra: Record<string, string> = {},
) => ({
  ...worldEnv,
  TEAMS_FILE: join(DATA, "teams.json"),
  PROVIDERS_FILE: join(DATA, "providers.json"),
  BUDGETS_FILE: join(DATA, "budgets.json"),
  ...extra,
});

export type Reply = { status: number; provider: string | null; body: any };

export async function chat(
  url: string,
  opts: { key?: string; importer?: string; role?: string; task: string; pad?: number },
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.importer) headers["x-importer"] = opts.importer;
  const content = `TASK ${opts.task}\nReply with the word pong.${opts.pad ? "\n" + "invoice line text ".repeat(opts.pad) : ""}`;
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: opts.role ?? "fast", messages: [{ role: "user", content }] }),
  }).catch(() => null);
  if (!r) return { status: 0, provider: null, body: null };
  return {
    status: r.status,
    provider: r.headers.get("x-gateway-provider"),
    body: await r.json().catch(() => null),
  };
}

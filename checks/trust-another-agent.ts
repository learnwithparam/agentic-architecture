// biome-ignore-all lint/style/useNamingConvention: token fields are snake_case on the wire.
// One agent hands work to another through the token service. trust.yaml says who may ask whom, and
// for which tools. The other agent gets a short token that names who asked and what it may use,
// and that token cannot be handed on or used as the asking agent's own. The check plays the agents.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Rule } from "../scripts/verify";
import { identityEnv, postJson, tokenFor } from "./issue-agent-identities";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, freshWorld, ROOT } from "./lib/world";

const ASK_CLASSIFICATION = { target: "classification-agent", tools: ["propose_code"] };

type Reply = { status: number; token: string; error: string };
type Outcome = {
  up?: boolean;
  allowed?: Reply;
  notListed?: Reply;
  wrongTool?: Reply;
  again?: Reply;
  extra?: Reply;
  verified?: { sub?: string; aud?: string | string[]; scope?: string[]; lifetime: number } | null;
  audited?: string[];
};

async function delegate(url: string, subject: string, ask: object): Promise<Reply> {
  const answer = await postJson(`${url}/delegate`, { subject_token: subject, ...ask });
  const body = answer.body as { access_token?: string; error?: string };
  return { status: answer.status, token: body.access_token ?? "", error: body.error ?? "" };
}

async function verify(url: string, token: string): Promise<Outcome["verified"]> {
  try {
    const keys = createRemoteJWKSet(new URL(`${url}/jwks`));
    const { payload } = await jwtVerify(token, keys, { issuer: "harbourgate-tokens" });
    const lifetime = Number(payload.exp) - Number(payload.iat);
    return { sub: payload.sub, aud: payload.aud, scope: payload.scope as string[], lifetime };
  } catch {
    return null;
  }
}

async function drive(url: string) {
  const paperwork = await tokenFor(url, "paperwork");
  const holds = await tokenFor(url, "holds");
  const allowed = await delegate(url, paperwork, ASK_CLASSIFICATION);
  const notListed = await delegate(url, holds, ASK_CLASSIFICATION);
  const wrongTool = await delegate(url, paperwork, {
    target: "classification-agent",
    tools: ["file_entry"],
  });
  const again = await delegate(url, allowed.token, { target: "holds-agent", tools: ["book_exam"] });
  return { allowed, notListed, wrongTool, again, verified: await verify(url, allowed.token) };
}

async function withTokens(folder: string, work: (url: string) => Promise<Outcome>) {
  const world = await freshWorld();
  try {
    const tokens = await startLearner(folder, "tokens", identityEnv(world.env));
    try {
      const outcome = await work(tokens.url);
      await Bun.sleep(100);
      const lines = allRows<{ detail: string }>(
        world,
        "SELECT detail FROM spans WHERE name = 'delegate'",
      );
      return { up: true, ...outcome, audited: lines.map((line) => line.detail) };
    } finally {
      await tokens.stop();
    }
  } finally {
    world.stop();
  }
}

// The same folder with one more line in trust.yaml and no code changed.
function withExtraTrust(folder: string): string {
  const copy = join(ROOT, "world", "state", `trust-${crypto.randomUUID()}`);
  mkdirSync(copy, { recursive: true });
  cpSync(folder, copy, { recursive: true });
  const file = join(copy, "trust.yaml");
  writeFileSync(
    file,
    `${readFileSync(file, "utf8")}holds-agent:\n  paperwork-agent: [read_shipment]\n`,
  );
  return copy;
}

const scenario = (folder: string) => withTokens(folder, drive);

async function extraScenario(folder: string): Promise<Outcome> {
  const copy = withExtraTrust(folder);
  try {
    return await withTokens(copy, async (url) => {
      const holds = await tokenFor(url, "holds");
      return {
        extra: await delegate(url, holds, { target: "paperwork-agent", tools: ["read_shipment"] }),
      };
    });
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

const run = (folder: string) => once("trust-another-agent", folder, scenario);
const runExtra = (folder: string) => once("trust-another-agent-extra", folder, extraScenario);

export default [
  {
    says: "a trusted agent gets a token for the other agent, signed by the token service",
    test: async (folder) => {
      const { allowed, verified } = await run(folder);
      return allowed?.status === 200 && verified?.sub === "paperwork-agent";
    },
    tryNext: "sign a token with sub = the asking agent, and send it back as access_token",
  },
  {
    says: "the token is for the other agent only and lists only the tools it was asked for",
    test: async (folder) => {
      const { verified } = await run(folder);
      return (
        verified?.aud === "agent:classification-agent" && verified.scope?.join() === "propose_code"
      );
    },
    tryNext: "set the audience to agent:<name> and add a scope claim with the allowed tools",
  },
  {
    says: "the token ends within one minute",
    test: async (folder) => {
      const lifetime = (await run(folder)).verified?.lifetime ?? 0;
      return lifetime > 0 && lifetime <= 60;
    },
    tryNext: "set the expiry to 60 seconds after it was issued",
  },
  {
    says: "an agent that is not listed in trust.yaml is refused with 403",
    test: async (folder) => (await run(folder)).notListed?.status === 403,
    tryNext: "look up caller then target in trust.yaml, and refuse when there is no line",
  },
  {
    says: "a tool outside the listed tools is refused, not quietly dropped",
    test: async (folder) => (await run(folder)).wrongTool?.status === 403,
    tryNext: "refuse the whole ask when any asked tool is not in the list",
  },
  {
    says: "a delegated token cannot be used to hand the work on to a third agent",
    test: async (folder) => {
      const again = (await run(folder)).again;
      return again !== undefined && again.status >= 400 && again.token === "";
    },
    tryNext: "accept only an agent's own token in /delegate, never one made for another agent",
  },
  {
    says: "each ask, allowed or refused, is written to the audit log",
    test: async (folder) => {
      const lines = (await run(folder)).audited ?? [];
      const has = (text: string) => lines.some((line) => line.includes(text));
      return has("allowed") && has("denied");
    },
    tryNext: "write a span named delegate with the caller, the target and the outcome",
  },
  {
    says: "a new line in trust.yaml works with no code change",
    test: async (folder) => (await runExtra(folder)).extra?.status === 200,
    tryNext: "read trust.yaml when the service starts; do not write the pairs in code",
  },
] satisfies Rule[];

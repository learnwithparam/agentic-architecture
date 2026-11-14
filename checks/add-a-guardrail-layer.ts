// biome-ignore-all lint/style/useNamingConvention: the tools use snake_case fields.
// The tool gateway reads the words as well as the caller. A call that carries a bank number is
// refused before it reaches a tool server, and a hidden instruction in a tool's answer is
// removed before the agent sees it. The rules live in guardrails.yaml, so a new rule needs no code.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { keyOf } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, freshWorld, ROOT } from "./lib/world";
import { startToolServers, type ToolServers, toolGatewayEnv } from "./register-approved-tools";

const BANK = "Please pay to DE89 3704 0044 0532 0130 00 today.";
const CLEAN = "Please send the packing list.";
const INJECTION = /ignore your rules/i;

type Answer = { status: number; text: string };
type Outcome = {
  up?: boolean;
  bank?: Answer;
  clean?: Answer;
  read?: Answer;
  secret?: Answer;
  reachedBank?: boolean;
  reachedSecret?: boolean;
  auditBank?: number;
  auditRead?: number;
};

async function ask(url: string, tool: string, input: object): Promise<Answer> {
  const headers = {
    authorization: `Bearer ${keyOf("paperwork")}`,
    "x-importer": "fjordline",
    "content-type": "application/json",
  };
  const body = JSON.stringify(input);
  const reply = await fetch(`${url}/tools/${tool}`, { method: "POST", headers, body }).catch(
    () => null,
  );
  return { status: reply?.status ?? 0, text: (await reply?.text()) ?? "" };
}

const email = (message: string) => ({ shipment_id: "HG-1058", message });

async function play(
  url: string,
  servers: ToolServers,
  world: Awaited<ReturnType<typeof freshWorld>>,
) {
  const bank = await ask(url, "email_importer", email(BANK));
  const reachedBank = servers.received.some((call) => call.tool === "email_importer");
  const clean = await ask(url, "email_importer", email(CLEAN));
  const read = await ask(url, "read_shipment", { shipment_id: "HG-1055" });
  await Bun.sleep(100);
  const audit = (tool: string) =>
    allRows(world, "SELECT 1 FROM spans WHERE name = ? AND detail LIKE '%guardrail%'", tool).length;
  return {
    bank,
    clean,
    read,
    reachedBank,
    auditBank: audit("email_importer"),
    auditRead: audit("read_shipment"),
  };
}

async function withGateway(
  folder: string,
  work: (
    url: string,
    servers: ToolServers,
    world: Awaited<ReturnType<typeof freshWorld>>,
  ) => Promise<Partial<Outcome>>,
) {
  const world = await freshWorld();
  const servers = startToolServers(world.api, false);
  try {
    const policy = await startLearner(folder, "policy", world.env);
    try {
      const settings = { ...toolGatewayEnv(world.env, servers), POLICY_URL: policy.url };
      const gateway = await startLearner(folder, "tools", settings);
      try {
        return { up: true, ...(await work(gateway.url, servers, world)) };
      } finally {
        await gateway.stop();
      }
    } finally {
      await policy.stop();
    }
  } finally {
    servers.stop();
    world.stop();
  }
}

// The same folder with one new rule added to guardrails.yaml and no code changed.
function withExtraRule(folder: string): string {
  const copy = join(ROOT, "world", "state", `guardrail-${crypto.randomUUID()}`);
  mkdirSync(copy, { recursive: true });
  cpSync(folder, copy, { recursive: true });
  const file = join(copy, "guardrails.yaml");
  const rule = "block_in_calls:\n  - name: case-code\n    pattern: 'CASE-\\d{4}'\n";
  const text = readFileSync(file, "utf8").replace(/block_in_calls:.*\n/, rule);
  writeFileSync(file, text);
  return copy;
}

function scenario(folder: string): Promise<Outcome> {
  return withGateway(folder, play);
}

async function extraScenario(folder: string): Promise<Outcome> {
  const copy = withExtraRule(folder);
  try {
    return await withGateway(copy, async (url, servers) => {
      const secret = await ask(url, "email_importer", email("Our file is CASE-1234."));
      const reachedSecret = servers.received.some((call) => call.tool === "email_importer");
      return { secret, reachedSecret };
    });
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

const run = (folder: string) => once("add-a-guardrail-layer", folder, scenario);
const runExtra = (folder: string) => once("add-a-guardrail-layer-extra", folder, extraScenario);

export default [
  {
    says: "a call that carries a bank number is refused with 422 and never reaches the tool server",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.bank?.status === 422 && outcome.reachedBank === false;
    },
    tryNext: "scan the call body against block_in_calls and answer 422 before you forward it",
  },
  {
    says: "the refusal names the guardrail in plain words",
    test: async (folder) => /guardrail/i.test((await run(folder)).bank?.text ?? ""),
    tryNext: "say which rule fired, such as: blocked by guardrail: bank-account",
  },
  {
    says: "a clean email still goes through",
    test: async (folder) => (await run(folder)).clean?.status === 200,
    tryNext: "only block a call when a rule matches its words",
  },
  {
    says: "a hidden instruction in a tool's answer is removed, and the rest of the answer stays",
    test: async (folder) => {
      const read = (await run(folder)).read;
      return (
        read?.status === 200 && !INJECTION.test(read.text) && read.text.includes("SLMU4931380")
      );
    },
    tryNext: "replace the words that match clean_in_results in the answer, and keep the rest",
  },
  {
    says: "each guardrail action is written to the audit log",
    test: async (folder) => {
      const outcome = await run(folder);
      return (outcome.auditBank ?? 0) > 0 && (outcome.auditRead ?? 0) > 0;
    },
    tryNext: "write an audit line that has the word guardrail for a block and for a clean-up",
  },
  {
    says: "a new rule added to guardrails.yaml works with no code change",
    test: async (folder) => {
      const outcome = await runExtra(folder);
      return outcome.secret?.status === 422 && outcome.reachedSecret === false;
    },
    tryNext:
      "read the rules from guardrails.yaml when the gateway starts; do not write them in code",
  },
] satisfies Rule[];

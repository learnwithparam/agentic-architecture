// biome-ignore-all lint/style/useNamingConvention: settings like RATE_LIMIT are in capitals.
// The model gateway slows a team that calls too fast (429 with retry-after), never lets that
// slow-down touch another team, and answers an exact repeat from memory for the same importer only.
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { gatewayEnv, keyOf } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { freshWorld, numberFrom } from "./lib/world";

const LIMIT = 5;

type Answer = { status: number; retryAfter: string | null; cache: string | null; message: string };
type Outcome = {
  limited?: Answer[];
  other?: Answer;
  first?: Answer;
  repeat?: Answer;
  otherImporter?: Answer;
  providerCallsAfterRepeat?: number;
  providerCallsAfterOther?: number;
  providerCallsBeforeRepeat?: number;
  limitedProviderCalls?: number;
  spendTotal?: number;
  billed?: number;
};

async function call(url: string, team: string, importer: string, task: string): Promise<Answer> {
  const body = {
    model: "fast",
    messages: [{ role: "user", content: `TASK ${task}\nReply with the word pong.` }],
  };
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${keyOf(team)}`,
    "x-importer": importer,
  };
  const reply = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!reply) return { status: 0, retryAfter: null, cache: null, message: "" };
  const json = (await reply.json().catch(() => null)) as { error?: { message?: string } } | null;
  return {
    status: reply.status,
    retryAfter: reply.headers.get("retry-after"),
    cache: reply.headers.get("x-gateway-cache"),
    message: String(json?.error?.message ?? ""),
  };
}

async function readTotals(world: World) {
  await Bun.sleep(100); // let the gateway finish writing its last spend row
  const count = (sql: string) => numberFrom(world, sql);
  return {
    limitedProviderCalls: count("SELECT COUNT(*) AS total FROM provider_calls WHERE status = 200"),
    spendTotal: count("SELECT COALESCE(SUM(cost_micros),0) AS total FROM spend_log"),
    billed: count("SELECT COALESCE(SUM(cost_micros),0) AS total FROM provider_calls"),
  };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  try {
    const settings = gatewayEnv(world.env, { RATE_LIMIT: String(LIMIT), RATE_WINDOW_MS: "600000" });
    const gateway = await startLearner(folder, "gateway", settings);
    try {
      const providerCalls = () =>
        numberFrom(world, "SELECT COUNT(*) AS total FROM provider_calls WHERE status = 200");
      // Cache: the same call twice for one importer, then once for another.
      const first = await call(gateway.url, "paperwork", "fjordline", "ping:1");
      const beforeRepeat = providerCalls();
      const repeat = await call(gateway.url, "paperwork", "fjordline", "ping:1");
      const afterRepeat = providerCalls();
      const otherImporter = await call(gateway.url, "paperwork", "northpoint", "ping:1");
      const afterOther = providerCalls();
      // Rate limit: one team sends more calls than its limit.
      const limited: Answer[] = [];
      for (let number = 1; number <= LIMIT + 2; number++) {
        limited.push(await call(gateway.url, "classification", "fjordline", `ping:${number + 10}`));
      }
      const other = await call(gateway.url, "holds", "northpoint", "ping:2");
      return {
        first,
        repeat,
        otherImporter,
        providerCallsBeforeRepeat: beforeRepeat,
        providerCallsAfterRepeat: afterRepeat,
        providerCallsAfterOther: afterOther,
        limited,
        other,
        ...(await readTotals(world)),
      };
    } finally {
      await gateway.stop();
    }
  } finally {
    world.stop();
  }
}

const run = (folder: string) => once("limit-and-cache-calls", folder, scenario);

export default [
  {
    says: `a team's first ${LIMIT} calls are answered and the next one gets 429`,
    test: async (folder) => {
      const { limited } = await run(folder);
      if (!limited) return false;
      const early = limited.slice(0, LIMIT).every((answer) => answer.status === 200);
      return early && limited.slice(LIMIT).every((answer) => answer.status === 429);
    },
    tryNext: "keep a list of call times per team and answer 429 when the window is full",
  },
  {
    says: "the 429 has a retry-after number of seconds and a plain message",
    test: async (folder) => {
      const refused = (await run(folder)).limited?.find((answer) => answer.status === 429);
      if (!refused) return false;
      return Number(refused.retryAfter) >= 1 && /try again/i.test(refused.message);
    },
    tryNext: "send the header retry-after and the words Try again in N seconds",
  },
  {
    says: "a call that got 429 never reached a model provider",
    test: async (folder) => {
      const outcome = await run(folder);
      const everyAnswer = [
        outcome.first,
        outcome.repeat,
        outcome.otherImporter,
        outcome.other,
        ...(outcome.limited ?? []),
      ];
      const fromProviders = everyAnswer.filter(
        (answer) => answer?.status === 200 && answer.cache !== "hit",
      );
      return fromProviders.length > 0 && outcome.limitedProviderCalls === fromProviders.length;
    },
    tryNext: "check the limit before you ask a provider, so a refused call costs nothing",
  },
  {
    says: "another team is still answered while one team is limited",
    test: async (folder) => (await run(folder)).other?.status === 200,
    tryNext: "count calls per team, not for everyone together",
  },
  {
    says: "an exact repeat for the same importer comes from memory and costs no provider call",
    test: async (folder) => {
      const outcome = await run(folder);
      const noNewCall = outcome.providerCallsAfterRepeat === outcome.providerCallsBeforeRepeat;
      return outcome.first?.status === 200 && outcome.repeat?.cache === "hit" && noNewCall;
    },
    tryNext: "save each answer under importer, role and messages, and send x-gateway-cache: hit",
  },
  {
    says: "the same words for another importer are not answered from memory",
    test: async (folder) => {
      const outcome = await run(folder);
      const reached =
        (outcome.providerCallsAfterOther ?? 0) > (outcome.providerCallsAfterRepeat ?? 0);
      return (
        outcome.otherImporter?.status === 200 && outcome.otherImporter.cache !== "hit" && reached
      );
    },
    tryNext: "put the importer in the cache key so one importer never sees another's answer",
  },
  {
    says: "the spend log still adds up to the providers' bill",
    test: async (folder) => {
      const outcome = await run(folder);
      return (outcome.billed ?? 0) > 0 && outcome.spendTotal === outcome.billed;
    },
    tryNext: "log only answered provider calls; a cache hit adds no row",
  },
] satisfies Rule[];

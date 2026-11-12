// bun run models: one tiny call per role on the chosen provider. Prints provider, role, pass or fail
// and the cost when the provider reports one. It never prints a key.
import { generateText } from "ai";
import { startWorld } from "../world/services";
import { KEY_NAME, modelFor, provider, ROLES } from "./models";

const p = provider();
const key = KEY_NAME[p];
if (key && !process.env[key]) {
  console.log(
    `LLM_PROVIDER is ${p} but ${key} is not set. Add it to .env (see .env.example) or use LLM_PROVIDER=replay.`,
  );
  process.exit(1);
}
const world =
  p === "replay"
    ? await startWorld({ db: `${import.meta.dir}/../world/state/models-check.db`, reset: true })
    : null;
if (world)
  Object.assign(process.env, {
    REPLAY_URL: world.env.REPLAY_URL,
    REPLAY_KEY: world.env.REPLAY_KEY,
  });
let failed = 0;
for (const [i, role] of ROLES.entries()) {
  try {
    const out = await generateText({
      model: modelFor(role),
      prompt: `TASK ping:${i + 1}\nReply with the word pong.`,
    });
    const ok = /pong/i.test(out.text);
    if (!ok) failed++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  provider ${p}  role ${role}  tokens ${out.usage.inputTokens ?? "?"} in, ${out.usage.outputTokens ?? "?"} out`,
    );
  } catch (e) {
    failed++;
    console.log(`FAIL  provider ${p}  role ${role}  ${(e as Error).message.split("\n")[0]}`);
  }
}
world?.stop();
if (world) {
  const cost = (world.db.query("SELECT SUM(cost_micros) AS c FROM provider_calls").get() as any).c;
  console.log(
    `Replay cost: USD ${(cost / 1e6).toFixed(6)} (fake prices from world/data/providers.json).`,
  );
}
process.exit(failed ? 1 : 0);

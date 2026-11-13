// biome-ignore-all lint/style/useNamingConvention: settings like REPLAY_URL are in capitals.
// bun run models: one tiny call per role on the chosen provider.
// It prints provider, role, pass or fail, and the cost when the provider reports one.
// It never prints a key.
import { generateText } from "ai";
import { startWorld, type World } from "../world/services";
import { KEY_NAME, modelFor, provider, ROLES, type Role } from "./models";

const chosenProvider = provider();
const keyName = KEY_NAME[chosenProvider];
if (keyName && !process.env[keyName]) {
  console.log(
    `LLM_PROVIDER is ${chosenProvider} but ${keyName} is not set. ` +
      "Add it to .env (see .env.example) or use LLM_PROVIDER=replay.",
  );
  process.exit(1);
}

// In replay mode there is no real provider, so we start the world's fake one.
async function startReplayWorld(): Promise<World | null> {
  if (chosenProvider !== "replay") return null;
  const replayWorld = await startWorld({
    db: `${import.meta.dir}/../world/state/models-check.db`,
    reset: true,
  });
  Object.assign(process.env, {
    REPLAY_URL: replayWorld.env.REPLAY_URL,
    REPLAY_KEY: replayWorld.env.REPLAY_KEY,
  });
  return replayWorld;
}

// Ask one role to say pong. Returns true when it did.
async function checkRole(role: Role, taskNumber: number): Promise<boolean> {
  try {
    const answer = await generateText({
      model: modelFor(role),
      prompt: `TASK ping:${taskNumber}\nReply with the word pong.`,
    });
    const passed = /pong/i.test(answer.text);
    const tokensIn = answer.usage.inputTokens ?? "?";
    const tokensOut = answer.usage.outputTokens ?? "?";
    const verdict = passed ? "PASS" : "FAIL";
    const tokens = `tokens ${tokensIn} in, ${tokensOut} out`;
    console.log(`${verdict}  provider ${chosenProvider}  role ${role}  ${tokens}`);
    return passed;
  } catch (error) {
    const firstLine = (error as Error).message.split("\n")[0];
    console.log(`FAIL  provider ${chosenProvider}  role ${role}  ${firstLine}`);
    return false;
  }
}

function printReplayCost(replayWorld: World): void {
  const sql = "SELECT SUM(cost_micros) AS total FROM provider_calls";
  const cost = (replayWorld.db.query(sql).get() as { total: number }).total;
  const dollars = (cost / 1e6).toFixed(6);
  console.log(`Replay cost: USD ${dollars} (fake prices from world/data/providers.json).`);
}

const world = await startReplayWorld();
let failed = 0;
for (const [index, role] of ROLES.entries()) {
  const passed = await checkRole(role, index + 1);
  if (!passed) failed++;
}
world?.stop();
if (world) printReplayCost(world);
process.exit(failed ? 1 : 0);

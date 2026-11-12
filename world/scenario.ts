// biome-ignore-all lint/style/useNamingConvention: the world's API names its fields in snake_case.
// Runs the open queue the way Harbourgate works now: Classification, then the broker desk,
// then Paperwork, then Holds. The Holds worker is killed once, right after it pays.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { data } from "./db";
import type { World } from "./services";

// Exit code 137 means the process was killed, like a worker that crashed. We restart it.
const KILLED = 137;

export async function runAgent(file: string, env: Record<string, string>, restarts = 1) {
  for (let attempt = 0; attempt <= restarts; attempt++) {
    const agent = Bun.spawn(["bun", file], {
      env: { ...process.env, ...env },
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await agent.exited;
    if (exitCode === 0) return;
    if (exitCode !== KILLED) throw new Error(`${file} failed with exit code ${exitCode}`);
    if (attempt === restarts) throw new Error(`${file} kept crashing`);
  }
}

type Broker = { id: string; licensed: boolean };
type UnsignedProposal = { line: string; code: string };

function firstLicensedBroker(): Broker {
  const broker = data<Broker[]>("brokers").find((candidate) => candidate.licensed);
  if (!broker) throw new Error("world/data/brokers.json has no licensed broker.");
  return broker;
}

// The broker desk: a licensed broker reviews every unsigned proposed code and signs it.
export async function brokerDesk(world: World) {
  const broker = firstLicensedBroker();
  const unsignedProposals = world.db
    .query(
      "SELECT p.line, p.code FROM proposals p LEFT JOIN signatures s ON s.line = p.line " +
        "WHERE s.line IS NULL",
    )
    .all() as UnsignedProposal[];
  for (const proposal of unsignedProposals) {
    await fetch(`${world.api}/broker/sign`, {
      method: "POST",
      body: JSON.stringify({ line_id: proposal.line, code: proposal.code, broker: broker.id }),
    });
  }
}

export async function runBefore(world: World, stateDir: string) {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const env = { ...world.env, STATE_DIR: stateDir, CRASH_AFTER: "pay_exam_fee" };
  const legacyFolder = join(import.meta.dir, "legacy");
  await runAgent(join(legacyFolder, "classification.ts"), env);
  await brokerDesk(world);
  await runAgent(join(legacyFolder, "paperwork.ts"), env);
  await runAgent(join(legacyFolder, "holds.ts"), env);
}

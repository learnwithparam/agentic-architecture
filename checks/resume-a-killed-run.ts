// biome-ignore-all lint/style/useNamingConvention: settings like RUN_ID are in capitals.
// The Holds worker dies right after it pays an exam fee. When it starts again, it must go on
// from the next step: no second payment, no second booking, no second model call.
// The check runs your worker from platform.toml and reads the world's tables.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startPlatform } from "../reference/platform";
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { keyOf } from "./lib/gateway";
import { platformToml } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, freshWorld, numberFrom, ROOT } from "./lib/world";

export const HELD_CONTAINERS = [
  { shipment: "HG-1050", kind: "x-ray", feeCents: 25000 },
  { shipment: "HG-1057", kind: "tailgate", feeCents: 40000 },
];
const WORKER_TIMEOUT_MS = 8000;
// What a killed process returns, the same code the crash drill uses.
const KILLED = 137;

export function putHolds(world: World): void {
  const insertHold = world.db.prepare(
    "INSERT INTO holds (shipment, kind, fee_cents) VALUES (?,?,?)",
  );
  const markHeld = world.db.prepare("UPDATE shipments SET status = 'held' WHERE id = ?");
  for (const container of HELD_CONTAINERS) {
    insertHold.run(container.shipment, container.kind, container.feeCents);
    markHeld.run(container.shipment);
  }
}

// A fresh folder for the worker's journal and the crash drill's marker.
export function freshStateFolder(name: string): string {
  const folder = join(ROOT, "world", "state", name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  return folder;
}

export type WorkerExit = { exitCode: number | null; output: string };

// Run the worker once, the way the platform would. A worker that never ends is stopped.
export async function runWorker(folder: string, settings: Record<string, string>) {
  const command = platformToml(folder).holds?.run;
  if (!command) return { exitCode: null, output: "platform.toml has no [holds] run command" };
  const worker = Bun.spawn(["sh", "-c", `exec ${command}`], {
    cwd: folder,
    env: { ...process.env, ...settings },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    worker.kill(9);
  }, WORKER_TIMEOUT_MS);
  const exitCode = await worker.exited;
  clearTimeout(timer);
  const output = await new Response(worker.stderr).text();
  return { exitCode: timedOut ? null : exitCode, output };
}

export async function workerSettings(world: World, stateFolder: string, runId: string) {
  const platform = await startPlatform(world, join(stateFolder, "platform.db"));
  const settings: Record<string, string> = {
    ...world.env,
    ...platform.env,
    AGENT: "holds-agent",
    TEAM_KEY: keyOf("holds"),
    RUN_ID: runId,
    STATE_DIR: stateFolder,
    JOURNAL_DB: join(stateFolder, "journal.db"),
  };
  return { platform, settings };
}

type Outcome = {
  error?: string;
  exits: (number | null)[];
  markerWritten: boolean;
  released: number;
  feesPerContainer: number[];
  bookings: number;
  modelCalls: number;
};

const RUN_ID = "holds-crash-drill";

function readWorld(world: World) {
  const feeRows = allRows<{ total: number }>(
    world,
    "SELECT COUNT(p.id) AS total FROM holds h LEFT JOIN payments p ON p.shipment = h.shipment " +
      "AND p.purpose = 'exam_fee' GROUP BY h.shipment ORDER BY h.shipment",
  );
  return {
    released: numberFrom(world, "SELECT COUNT(*) AS total FROM holds WHERE released = 1"),
    feesPerContainer: feeRows.map((row) => row.total),
    bookings: numberFrom(
      world,
      "SELECT COUNT(*) AS total FROM tool_audit WHERE tool = 'book_exam' AND outcome = 'ok'",
    ),
    modelCalls: numberFrom(
      world,
      `SELECT COUNT(*) AS total FROM spend_log WHERE run_id = '${RUN_ID}' AND status = 'ok'`,
    ),
  };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  putHolds(world);
  const stateFolder = freshStateFolder("crash-drill");
  const { platform, settings } = await workerSettings(world, stateFolder, RUN_ID);
  try {
    const crashSettings = { ...settings, CRASH_AFTER: "pay_exam_fee" };
    const exits: (number | null)[] = [];
    const firstTry = await runWorker(folder, crashSettings);
    exits.push(firstTry.exitCode);
    // Like a platform, start the worker again after it dies. Same run, same journal.
    if (firstTry.exitCode === KILLED) exits.push((await runWorker(folder, crashSettings)).exitCode);
    const markerWritten = existsSync(join(stateFolder, "worker-crashed"));
    return { exits, markerWritten, ...readWorld(world) };
  } finally {
    await platform.stop();
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("resume-a-killed-run", folder, scenario);
}

const containerCount = HELD_CONTAINERS.length;

export default [
  {
    says: "the worker really died right after paying (the crash drill ran)",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.exits?.[0] === KILLED && outcome.markerWritten;
    },
    tryNext: 'keep crashDrill("pay_exam_fee") right after the pay step, and run holds.ts by hand',
  },
  {
    says: "after the restart, the worker finished and both containers were released",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.exits?.[1] === 0 && outcome.released === containerCount;
    },
    tryNext: "run JOURNAL_DB=journal.db bun holds.ts twice and read what it prints the second time",
  },
  {
    says: "each held container's exam fee was paid exactly once",
    test: async (folder) => {
      const outcome = await run(folder);
      const fees = outcome.feesPerContainer ?? [];
      return fees.length === containerCount && fees.every((count) => count === 1);
    },
    tryNext: "save each finished step in the journal file, and skip a step the journal has",
  },
  {
    says: "each exam was booked once: the restart went on from the next step",
    test: async (folder) => (await run(folder)).bookings === containerCount,
    tryNext: "wrap book_exam in step() too, so a restart does not book again",
  },
  {
    says: "model calls equal decision steps: one plan per container, none repeated",
    test: async (folder) => (await run(folder)).modelCalls === containerCount,
    tryNext: "wrap the model call in step() as well; a saved plan must not be asked for again",
  },
] satisfies Rule[];

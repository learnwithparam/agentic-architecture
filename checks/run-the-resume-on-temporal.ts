// biome-ignore-all lint/style/useNamingConvention: settings like TASK_QUEUE are in capitals.
// The resume layer on Temporal. The check starts the dev server from assignment/compose.yml if it
// is not running, starts one Holds workflow, kills the worker after the booking, starts the worker
// again, and then reads the workflow's history through the Temporal client.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { once } from "./lib/session";
import { freshWorld, numberFrom, ROOT } from "./lib/world";
import { freshStateFolder, putHolds, workerSettings } from "./resume-a-killed-run";

const ADDRESS = "127.0.0.1:7233";
const COMPOSE_FILE = join(ROOT, "assignment", "compose.yml");
const KILLED = 137;
const WORKER_WAIT_MS = 25000;
const RESULT_WAIT_MS = 25000;
const HOLD = { shipment: "HG-1050", importer: "ridgeway", fee_cents: 25000 };
const EVENT = temporal.api.enums.v1.EventType;

async function temporalIsUp(): Promise<boolean> {
  try {
    const connection = await Connection.connect({ address: ADDRESS, connectTimeout: 2000 });
    await connection.close();
    return true;
  } catch {
    return false;
  }
}

// Start the dev server only when nobody has. Whoever starts it stops it again when the run ends.
async function ensureTemporal(): Promise<void> {
  if (await temporalIsUp()) return;
  const started = Bun.spawnSync(["docker", "compose", "-f", COMPOSE_FILE, "up", "-d", "--wait"]);
  if (started.exitCode !== 0) throw new Error("docker compose could not start Temporal");
  process.on("exit", () => {
    Bun.spawnSync(["docker", "compose", "-f", COMPOSE_FILE, "down", "-v"]);
  });
}

type WorkerRun = { exitCode: number | null };

// Run the worker the way a platform would. A worker still alive after the wait is stopped.
async function runWorker(folder: string, env: Record<string, string>, log: string) {
  const worker = Bun.spawn(["bun", "worker.ts"], {
    cwd: folder,
    env: { ...process.env, ...env },
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    worker.kill(9);
  }, WORKER_WAIT_MS);
  const exitCode = await worker.exited;
  clearTimeout(timer);
  // A process killed by a signal reports no exit code, so a kill the drill made reads as 137.
  const diedByDrill = worker.signalCode === "SIGKILL";
  if (timedOut) return { exitCode: null } satisfies WorkerRun;
  return { exitCode: diedByDrill ? KILLED : exitCode } satisfies WorkerRun;
}

function startWorker(folder: string, env: Record<string, string>, log: string) {
  return Bun.spawn(["bun", "worker.ts"], {
    cwd: folder,
    env: { ...process.env, ...env },
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  });
}

type History = { completed: Record<string, number>; status: string };

// Count the completed events of each activity, using the scheduled event each one points to.
async function readHistory(client: Client, workflowId: string): Promise<History> {
  const handle = client.workflow.getHandle(workflowId);
  const history = await handle.fetchHistory();
  const names = new Map<string, string>();
  const completed: Record<string, number> = {};
  for (const event of history.events ?? []) {
    const scheduled = event.activityTaskScheduledEventAttributes;
    if (scheduled) names.set(String(event.eventId), scheduled.activityType?.name ?? "");
    const done = event.activityTaskCompletedEventAttributes;
    if (event.eventType === EVENT.EVENT_TYPE_ACTIVITY_TASK_COMPLETED && done) {
      const name = names.get(String(done.scheduledEventId)) ?? "";
      completed[name] = (completed[name] ?? 0) + 1;
    }
  }
  const description = await handle.describe();
  return { completed, status: description.status.name };
}

type Outcome = {
  error?: string;
  firstExit: number | null;
  history: History;
  bookings: number;
  payments: number;
};

function readWorld(world: World) {
  const sql = (table: string) => `SELECT COUNT(*) AS total FROM ${table}`;
  return {
    bookings: numberFrom(world, `${sql("tool_audit")} WHERE tool = 'book_exam' AND outcome = 'ok'`),
    payments: numberFrom(world, `${sql("payments")} WHERE shipment = 'HG-1050'`),
  };
}

async function waitForResult(client: Client, workflowId: string): Promise<void> {
  const handle = client.workflow.getHandle(workflowId);
  const timeout = new Promise((resolve) => setTimeout(resolve, RESULT_WAIT_MS));
  await Promise.race([handle.result().catch(() => undefined), timeout]);
}

export async function scenario(folder: string): Promise<Outcome> {
  await ensureTemporal();
  const world = await freshWorld();
  putHolds(world);
  const stateFolder = freshStateFolder("temporal-drill");
  mkdirSync(stateFolder, { recursive: true });
  const { platform, settings } = await workerSettings(world, stateFolder, "temporal-drill");
  const suffix = Date.now();
  const env = {
    ...settings,
    TEMPORAL_ADDRESS: ADDRESS,
    TASK_QUEUE: `holds-${suffix}`,
    CRASH_AFTER: "pay_exam_fee",
  };
  const connection = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection });
  const workflowId = `holds-${suffix}`;
  const handle = await client.workflow.start("clearHold", {
    taskQueue: env.TASK_QUEUE,
    workflowId,
    args: [HOLD],
  });
  try {
    const log = join(stateFolder, "worker.log");
    const first = await runWorker(folder, env, log);
    // The platform starts the worker again after it dies. Same workflow, same server.
    if (first.exitCode === KILLED) {
      const second = startWorker(folder, env, log);
      await waitForResult(client, workflowId);
      second.kill(9);
    }
    const history = await readHistory(client, workflowId);
    return { firstExit: first.exitCode, history, ...readWorld(world) };
  } finally {
    await handle.terminate("check finished").catch(() => undefined);
    await connection.close();
    await platform.stop();
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("run-the-resume-on-temporal", folder, scenario);
}

function clientVersion(): string {
  const manifest = join(ROOT, "node_modules", "@temporalio", "client", "package.json");
  if (!existsSync(manifest)) return "not installed";
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

// The course's own checks must stay green. Run them in the repo, outside this step.
function existingChecksPass(): boolean {
  const structure = Bun.spawnSync(["bun", "scripts/check.ts"], { cwd: ROOT });
  const tests = Bun.spawnSync(["bun", "test"], { cwd: ROOT });
  return structure.exitCode === 0 && tests.exitCode === 0;
}

const ACTIVITIES = ["bookExam", "payExamFee"];

export default [
  {
    says: "@temporalio/client resolves to 1.25.0",
    test: () => clientVersion() === "1.25.0",
    tryNext: "pin it: bun add -E @temporalio/client@1.25.0",
  },
  {
    says: "the worker really died after the booking (the crash drill ran)",
    test: async (folder) => (await run(folder)).firstExit === KILLED,
    tryNext:
      'keep crashDrill("pay_exam_fee") at the top of payExamFee, and start worker.ts by hand',
  },
  {
    says: "the workflow reaches Completed after the worker was killed and started again",
    test: async (folder) => (await run(folder)).history?.status === "COMPLETED",
    tryNext: "call bookExam then payExamFee from clearHold, and open http://localhost:8233",
  },
  {
    says: "each activity has exactly one completed event in the history",
    test: async (folder) => {
      const completed = (await run(folder)).history?.completed ?? {};
      return ACTIVITIES.every((name) => completed[name] === 1);
    },
    tryNext: "make each step one activity: bookExam and payExamFee, each called once",
  },
  {
    says: "the exam was booked once and the fee was paid once",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.bookings === 1 && outcome.payments === 1;
    },
    tryNext: "call the same tools as holds.ts, and use one idempotency key per shipment",
  },
  {
    says: "the course's existing checks still pass",
    test: () => existingChecksPass(),
    tryNext: "undo changes outside this step, then run bun run check",
  },
] satisfies Rule[];

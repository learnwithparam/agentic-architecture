// biome-ignore-all lint/style/useNamingConvention: the run API and the ledger use snake_case.
// One run API runs both shapes: Classification as a workflow, Holds as an agent loop with a
// step limit. The check starts your run API on top of the finished gateway and tool gateway,
// starts runs over HTTP, and reads the world's tables. It never reads a model's reply.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startPlatform } from "../reference/platform";
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { gatewayEnv } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once, threeRuns } from "./lib/session";
import { allRows, freshWorld, numberFrom, ROOT } from "./lib/world";

type RunView = { run_id?: string; status?: string; shape?: string };
type StartedRun = { asked: object; runId: string | null; view: RunView | null };

const WORKFLOW_SHIPMENTS = [
  { shipment: "HG-1049", importer: "fjordline" },
  { shipment: "HG-1050", importer: "ridgeway" },
  { shipment: "HG-1051", importer: "northpoint" },
];
// Customs holds HG-1050, so the Holds agent can book, pay and see it released.
const HELD = { shipment: "HG-1050", importer: "ridgeway" };
// HG-1057 has no hold yet, so booking its exam fails every time: a run that cannot finish.
const STUCK = { shipment: "HG-1057", importer: "northpoint" };
const STEP_LIMIT = 4;
const WAIT_FOR_RUN_MS = 4000;

type Outcome = {
  error?: string;
  up?: boolean;
  workflows: StartedRun[];
  holds: StartedRun | null;
  stuck: StartedRun | null;
  world: Snapshot;
};

// Everything the rules need, read from the world before it stops.
type Snapshot = {
  proposedLines: string[];
  linesByShipment: Record<string, string[]>;
  modelCallsByRun: Record<string, number>;
  toolCallsByRun: Record<string, number>;
  spansByRun: Record<string, number>;
  callsWithNoRun: number;
  heldReleased: boolean;
  examFees: number;
};

function putHoldOn(world: World, shipment: string): void {
  world.db
    .prepare("INSERT INTO holds (shipment, kind, fee_cents) VALUES (?, 'x-ray', 25000)")
    .run(shipment);
  world.db.prepare("UPDATE shipments SET status = 'held' WHERE id = ?").run(shipment);
}

async function readRun(runsUrl: string, runId: string): Promise<RunView | null> {
  const response = await fetch(`${runsUrl}/runs/${runId}`).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null);
}

// Start a run and wait until it is no longer running, or until the wait runs out.
async function startAndWait(runsUrl: string, asked: object): Promise<StartedRun> {
  const request = { method: "POST", body: JSON.stringify(asked) };
  const response = await fetch(`${runsUrl}/runs`, request).catch(() => null);
  const started: RunView | null = await response?.json().catch(() => null);
  const runId = started?.run_id ?? null;
  if (!runId) return { asked, runId, view: null };
  const deadline = Date.now() + WAIT_FOR_RUN_MS;
  let view = await readRun(runsUrl, runId);
  while (view?.status === "running" && Date.now() < deadline) {
    await Bun.sleep(50);
    view = await readRun(runsUrl, runId);
  }
  return { asked, runId, view };
}

function countByRun(world: World, table: string): Record<string, number> {
  const sql = `SELECT run_id, COUNT(*) AS total FROM ${table} GROUP BY run_id`;
  const rows = allRows<{ run_id: string; total: number }>(world, sql);
  return Object.fromEntries(rows.map((row) => [row.run_id, row.total]));
}

function linesByShipment(world: World): Record<string, string[]> {
  const lines: Record<string, string[]> = {};
  for (const { shipment } of WORKFLOW_SHIPMENTS) {
    const rows = allRows<{ id: string }>(
      world,
      "SELECT id FROM lines WHERE shipment = ?",
      shipment,
    );
    lines[shipment] = rows.map((row) => row.id);
  }
  return lines;
}

const NO_RUN = (table: string) =>
  `SELECT COUNT(*) AS total FROM ${table} WHERE run_id IS NULL OR run_id = ''`;

function snapshot(world: World): Snapshot {
  const proposals = allRows<{ line: string }>(
    world,
    "SELECT line FROM proposals WHERE agent = 'classification-agent'",
  );
  const released = numberFrom(
    world,
    `SELECT COUNT(*) AS total FROM holds WHERE shipment = '${HELD.shipment}' AND released = 1`,
  );
  return {
    proposedLines: proposals.map((row) => row.line),
    linesByShipment: linesByShipment(world),
    modelCallsByRun: countByRun(world, "spend_log"),
    toolCallsByRun: countByRun(world, "tool_audit"),
    spansByRun: countByRun(world, "spans"),
    callsWithNoRun:
      numberFrom(world, NO_RUN("spend_log")) + numberFrom(world, NO_RUN("tool_audit")),
    heldReleased: released === 1,
    examFees: numberFrom(world, "SELECT COUNT(*) AS total FROM payments"),
  };
}

async function startEveryRun(runsUrl: string) {
  const workflows = await Promise.all(
    WORKFLOW_SHIPMENTS.map((target) =>
      startAndWait(runsUrl, { team: "classification", ...target }),
    ),
  );
  const holds = await startAndWait(runsUrl, { team: "holds", ...HELD });
  const stuck = await startAndWait(runsUrl, { team: "holds", ...STUCK, max_steps: STEP_LIMIT });
  return { workflows, holds, stuck };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  putHoldOn(world, HELD.shipment);
  const platform = await startPlatform(world, join(ROOT, "world", "state", "run-journal.db"));
  try {
    const settings = gatewayEnv({ ...world.env, ...platform.env });
    const runApi = await startLearner(folder, "runs", settings);
    try {
      const runs = await startEveryRun(runApi.url);
      // Give the gateways a moment to write their last rows.
      await Bun.sleep(150);
      return { up: true, ...runs, world: snapshot(world) };
    } finally {
      await runApi.stop();
    }
  } finally {
    await platform.stop();
    world.stop();
  }
}

// Every rule must hold in three fresh runs, because the Holds agent follows the model's choices.
function inThreeRuns(folder: string, passes: (outcome: Outcome) => boolean): Promise<boolean> {
  const runNumbered = (runNumber: number) => once(`run-both-shapes-${runNumber}`, folder, scenario);
  return threeRuns(runNumbered, (outcome) => !outcome.error && passes(outcome));
}

const statusOf = (run: StartedRun | null) => run?.view?.status;
const startedRuns = (outcome: Outcome) => [...outcome.workflows, outcome.holds, outcome.stuck];
const callsFor = (counts: Record<string, number>, run: StartedRun | null) =>
  counts[run?.runId ?? ""] ?? 0;

function everyRunHasAnId(outcome: Outcome): boolean {
  const ids = startedRuns(outcome).map((run) => run?.runId);
  const allViewed = startedRuns(outcome).every((run) => run?.view?.run_id === run?.runId);
  return ids.every(Boolean) && new Set(ids).size === ids.length && allViewed;
}

function workflowsFinished(outcome: Outcome): boolean {
  const allCompleted = outcome.workflows.every((run) => statusOf(run) === "completed");
  const allLines = Object.values(outcome.world.linesByShipment).flat();
  const everyLineProposed = allLines.every((line) => outcome.world.proposedLines.includes(line));
  return allCompleted && allLines.length > 0 && everyLineProposed;
}

function workflowsAskOncePerLine(outcome: Outcome): boolean {
  return outcome.workflows.every((run, index) => {
    const shipment = WORKFLOW_SHIPMENTS[index].shipment;
    const lineCount = outcome.world.linesByShipment[shipment].length;
    return callsFor(outcome.world.modelCallsByRun, run) === lineCount;
  });
}

// Book, pay and wait for release are three actions. An agent asks the model before each one.
function holdsAgentChoseEachStep(outcome: Outcome): boolean {
  const modelCalls = callsFor(outcome.world.modelCallsByRun, outcome.holds);
  const completed = statusOf(outcome.holds) === "completed";
  return completed && outcome.world.heldReleased && outcome.world.examFees === 1 && modelCalls >= 3;
}

function stuckRunStopped(outcome: Outcome): boolean {
  const modelCalls = callsFor(outcome.world.modelCallsByRun, outcome.stuck);
  const stopped = statusOf(outcome.stuck) === "stopped_at_limit";
  return stopped && modelCalls >= 1 && modelCalls <= STEP_LIMIT;
}

function everyCallCarriesItsRun(outcome: Outcome): boolean {
  const { modelCallsByRun, toolCallsByRun, spansByRun, callsWithNoRun } = outcome.world;
  const everyRunRecorded = startedRuns(outcome).every(
    (run) =>
      callsFor(modelCallsByRun, run) > 0 &&
      callsFor(toolCallsByRun, run) > 0 &&
      callsFor(spansByRun, run) > 0,
  );
  return everyRunRecorded && callsWithNoRun === 0;
}

const SECTIONS = ["## Shape", "## Why", "## What would change it"];

// The words under one heading, without HTML comments, up to the next heading.
function sectionText(markdown: string, heading: string): string {
  const after = markdown.split(heading)[1] ?? "";
  const section = after.split(/\n## /)[0];
  return section.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function decisionFileComplete(folder: string): boolean {
  const path = join(folder, "decisions", "run-shape.md");
  if (!existsSync(path)) return false;
  const markdown = readFileSync(path, "utf8");
  const filled = SECTIONS.every((heading) => sectionText(markdown, heading).length > 20);
  const shapeText = sectionText(markdown, "## Shape").toLowerCase();
  const namesEveryTeam = ["classification", "paperwork", "holds"].every((team) =>
    shapeText.includes(team),
  );
  return filled && namesEveryTeam;
}

export default [
  {
    says: "your run API starts from platform.toml and answers GET /health",
    test: (folder) => inThreeRuns(folder, (outcome) => outcome.up === true),
    tryNext: "run PORT=4300 bun runs.ts in your folder and fix any error it prints",
  },
  {
    says: "POST /runs gives each run its own run_id, and GET /runs/:id shows that run",
    test: (folder) => inThreeRuns(folder, everyRunHasAnId),
    tryNext: "answer POST /runs with { run_id } and keep each run so GET /runs/:id can find it",
  },
  {
    says: "the Classification workflow completes on 3 shipments and proposes a code for every line",
    test: (folder) => inThreeRuns(folder, workflowsFinished),
    tryNext: "map classification to the workflow shape and set status completed at its end",
  },
  {
    says: "the Classification workflow asks the model once per invoice line, no more",
    test: (folder) => inThreeRuns(folder, workflowsAskOncePerLine),
    tryNext: "keep Classification a workflow, and send x-run so each model call counts for its run",
  },
  {
    says: "the Holds agent asks the model before each action, pays once and gets HG-1050 released",
    test: (folder) => inThreeRuns(folder, holdsAgentChoseEachStep),
    tryNext: "map holds to the agent shape, so the model picks every next action in a loop",
  },
  {
    says: `a Holds run that cannot finish ends as stopped_at_limit within ${STEP_LIMIT} steps`,
    test: (folder) => inThreeRuns(folder, stuckRunStopped),
    tryNext: "count the turns of the agent loop and stop at max_steps with status stopped_at_limit",
  },
  {
    says: "every model call, tool call and span carries its run's id",
    test: (folder) => inThreeRuns(folder, everyCallCarriesItsRun),
    tryNext: "send x-run: <run id> on every call to the model gateway and the tool gateway",
  },
  {
    says: "decisions/run-shape.md fills in Shape, Why and What would change it, for every team",
    test: (folder) => decisionFileComplete(folder),
    tryNext: "write a few lines under each heading; name classification, paperwork and holds",
  },
] satisfies Rule[];

// biome-ignore-all lint/style/useNamingConvention: the run API names its fields in snake_case.
// The run API: one door to start a run for any team, and one place to look a run up.
//   POST /runs      { team, importer, shipment, max_steps? }  answers 202 { run_id, status }
//   GET  /runs/:id  answers { run_id, team, importer, shipment, shape, status, steps }
import { teamNamed } from "./platform-client";
import {
  classificationWorkflow,
  holdsAgentLoop,
  holdsWorkflow,
  type RunRecord,
  type RunStatus,
} from "./runners";

type StartRequest = { team?: string; importer?: string; shipment?: string; max_steps?: number };

// The shape each team's work takes. decisions/run-shape.md says why.
// TODO: today every team runs as a workflow. Which shape fits Holds?
const SHAPE_BY_TEAM: Record<string, "workflow" | "agent"> = {
  classification: "workflow",
  holds: "workflow",
};

// The runner for each team whose shape is a workflow.
const WORKFLOW_BY_TEAM: Record<string, (run: RunRecord) => Promise<RunStatus>> = {
  classification: classificationWorkflow,
  holds: holdsWorkflow,
};

const DEFAULT_STEP_LIMIT = 8;
const runs = new Map<string, RunRecord>();

function publicView(run: RunRecord) {
  const { runId, team, importer, shipment, shape, status, steps, error } = run;
  return { run_id: runId, team, importer, shipment, shape, status, steps, error };
}

// The run goes on in the background. GET /runs/:id shows how far it got.
async function carryOut(run: RunRecord, stepLimit: number): Promise<void> {
  try {
    if (run.shape === "workflow") run.status = await WORKFLOW_BY_TEAM[run.team](run);
    else run.status = await holdsAgentLoop(run, stepLimit);
  } catch (error) {
    run.status = "failed";
    run.error = String((error as Error).message);
  }
}

async function startRun(request: Request): Promise<Response> {
  const asked: StartRequest = await request.json().catch(() => ({}));
  const team = teamNamed(asked.team ?? "");
  const shape = SHAPE_BY_TEAM[asked.team ?? ""];
  if (!team || !shape) return Response.json({ error: "no runner for that team" }, { status: 400 });
  if (!asked.importer || !asked.shipment) {
    return Response.json({ error: "name the importer and the shipment" }, { status: 400 });
  }
  const run: RunRecord = {
    runId: `run-${crypto.randomUUID()}`,
    team: team.team,
    agent: team.agent,
    teamKey: team.key,
    importer: asked.importer,
    shipment: asked.shipment,
    shape,
    status: "running",
    steps: [],
  };
  runs.set(run.runId, run);
  carryOut(run, asked.max_steps ?? DEFAULT_STEP_LIMIT);
  return Response.json({ run_id: run.runId, status: run.status }, { status: 202 });
}

function handleRequest(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname === "/runs" && request.method === "POST") return startRun(request);
  const runId = url.pathname.match(/^\/runs\/([^/]+)$/)?.[1];
  const run = runs.get(runId ?? "");
  if (run && request.method === "GET") return Response.json(publicView(run));
  return Response.json({ error: "not found" }, { status: 404 });
}

const server = Bun.serve({ port: Number(process.env.PORT ?? 4300), fetch: handleRequest });
console.log(`run API listening on ${server.port}`);

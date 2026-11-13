// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// The two run shapes. A workflow follows a path written in code.
// An agent loop asks the model for the next action, again and again, until it is done or stopped.
import { askModel, callTool, type RunIdentity } from "./platform-client";

export type RunStatus = "running" | "completed" | "stopped_at_limit" | "failed";
export type RunRecord = RunIdentity & {
  shipment: string;
  shape: "workflow" | "agent";
  status: RunStatus;
  steps: string[];
  error?: string;
};

type InvoiceLine = { id: string; description: string };
type HoldPlan = { plan?: string[]; fee_cents?: number };

// A tool that fails stops a workflow: the next step needs this one's result.
async function mustCall<Body>(run: RunRecord, name: string, input: object): Promise<Body> {
  const answer = await callTool<Body>(run, name, input);
  run.steps.push(name);
  if (!answer.ok) throw new Error(`${name} failed with status ${answer.status}`);
  return answer.body;
}

async function classifyLine(run: RunRecord, line: InvoiceLine): Promise<void> {
  const tariff = await mustCall<{ codes: unknown[] }>(run, "lookup_tariff", {
    query: line.description,
  });
  const candidates = JSON.stringify(tariff.codes);
  const prompt = `Pick a tariff code for: ${line.description}\nCandidates: ${candidates}`;
  const task = `classify:${line.id}`;
  const answer = await askModel<{ code: string; reason: string }>(run, "smart", task, prompt);
  const proposal = { line_id: line.id, code: answer.code, reason: answer.reason };
  await mustCall(run, "propose_code", proposal);
}

// Classification is a workflow: read the shipment, then the same three moves for every line.
export async function classificationWorkflow(run: RunRecord): Promise<RunStatus> {
  const shipmentOnly = { shipment_id: run.shipment };
  const details = await mustCall<{ lines: InvoiceLine[] }>(run, "read_shipment", shipmentOnly);
  for (const line of details.lines) await classifyLine(run, line);
  return "completed";
}

// Each action the Holds model may choose, and the tool call that does it.
// An action counts as done only when the tool says it worked.
async function takeAction(run: RunRecord, action: string, feeCents: number): Promise<boolean> {
  const shipmentOnly = { shipment_id: run.shipment };
  run.steps.push(action);
  if (action === "book_exam") return (await callTool(run, "book_exam", shipmentOnly)).ok;
  if (action === "pay_exam_fee") {
    const payment = {
      ...shipmentOnly,
      purpose: "exam_fee",
      amount_cents: feeCents,
      idempotency_key: `${run.runId}:exam_fee:${run.shipment}`,
    };
    return (await callTool(run, "pay_fee", payment)).ok;
  }
  if (action === "wait_for_release") {
    const release = await callTool<{ released?: boolean }>(run, "check_release", shipmentOnly);
    return release.body.released === true;
  }
  return false;
}

// The Holds team's old runner: plan once, then the same three tool calls in a fixed order.
export async function holdsWorkflow(run: RunRecord): Promise<RunStatus> {
  const plan = await askModel<HoldPlan>(run, "fast", `hold:${run.shipment}`, "Plan the hold.");
  for (const action of plan.plan ?? []) await takeAction(run, action, plan.fee_cents ?? 0);
  return "completed";
}

// Holds is an agent loop. Each turn the model sees what is done and the loop takes the next action.
// TODO: stop after stepLimit turns and return "stopped_at_limit".
export async function holdsAgentLoop(run: RunRecord, stepLimit: number): Promise<RunStatus> {
  const done: string[] = [];
  console.log(`agent loop for ${run.runId}, asked to stop after ${stepLimit} turns`);
  while (true) {
    const prompt = `Done so far: ${done.join(", ") || "nothing"}. Pick the next action.`;
    const reply = await askModel<HoldPlan>(run, "fast", `hold:${run.shipment}`, prompt);
    const nextAction = (reply.plan ?? []).find((action) => !done.includes(action));
    if (!nextAction) return "completed";
    const worked = await takeAction(run, nextAction, reply.fee_cents ?? 0);
    if (worked) done.push(nextAction);
  }
}

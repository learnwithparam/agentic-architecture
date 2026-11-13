// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// One entry, traced end to end. The Classification agent reads the shipment, proposes a code
// for each line, and on a rush job tries to file. Every step is a span in one trace.
import { askModel, callTool, type ToolAnswer } from "./platform-client";
import { endSpan, flush, type Span, startSpan } from "./tracing";

type InvoiceLine = { id: string; description: string };
type ShipmentDetails = { shipment: { rush: number }; lines: InvoiceLine[] };

const settings = process.env;
const shipmentId = String(settings.SHIPMENT);

// TODO: a tool span should name the tool (gen_ai.tool.name) and the policy decision
// (policy.decision). Should it copy the tool's input and output? Look at what they hold.
// TODO: every span should join the run's trace. Pass the parent to startSpan.
async function tracedTool<Body>(parent: Span, name: string, input: object) {
  console.log(`tool call under ${parent.name}`);
  const span = startSpan(`execute_tool ${name}`, undefined, {
    "gen_ai.operation.name": "execute_tool",
    "tool.input": JSON.stringify(input),
  });
  const answer: ToolAnswer<Body> = await callTool<Body>(name, input);
  span.attributes["tool.output"] = JSON.stringify(answer.body);
  endSpan(span);
  return answer;
}

// TODO: a model span should name the role (gen_ai.request.model) and the tokens the gateway
// counted (gen_ai.usage.input_tokens and gen_ai.usage.output_tokens).
async function tracedModel<Answer>(parent: Span, task: string, prompt: string) {
  console.log(`model call under ${parent.name}`);
  const span = startSpan("chat smart", undefined, { "gen_ai.operation.name": "chat" });
  const reply = await askModel<Answer>("smart", task, prompt);
  endSpan(span);
  return reply.answer;
}

async function classifyLine(
  run: Span,
  line: InvoiceLine,
): Promise<{ line_id: string; code: string }> {
  const tariff = await tracedTool<{ codes: unknown[] }>(run, "lookup_tariff", {
    query: line.description,
  });
  const candidates = JSON.stringify(tariff.body.codes);
  const prompt = `Pick a tariff code for: ${line.description}\nCandidates: ${candidates}`;
  const task = `classify:${line.id}`;
  const answer = await tracedModel<{ code: string; reason: string }>(run, task, prompt);
  const proposal = { line_id: line.id, code: answer.code, reason: answer.reason };
  await tracedTool(run, "propose_code", proposal);
  return { line_id: line.id, code: answer.code };
}

// The run span is the root of the trace. Its baggage reaches every span below it.
// TODO: today the baggage is empty. Which importer, team and run is this work for?
const run = startSpan(`invoke_agent ${settings.AGENT}`, undefined, {
  "gen_ai.operation.name": "invoke_agent",
  "gen_ai.agent.name": String(settings.AGENT),
});

const details = await tracedTool<ShipmentDetails>(run, "read_shipment", {
  shipment_id: shipmentId,
});
const codes = [];
for (const line of details.body.lines) codes.push(await classifyLine(run, line));
// On a rush job the agent tries to file at once. The tool gateway's policy refuses.
if (details.body.shipment.rush) {
  await tracedTool(run, "file_entry", { shipment_id: shipmentId, lines: codes });
}
endSpan(run);
await flush("classification-agent");

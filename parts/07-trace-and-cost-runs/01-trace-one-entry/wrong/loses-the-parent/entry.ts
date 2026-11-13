// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// One entry, traced end to end. The Classification agent reads the shipment, proposes a code
// for each line, and on a rush job tries to file. Every step is a span in one trace.
import { askModel, callTool, type ToolAnswer } from "./platform-client";
import { endSpan, flush, type Span, startSpan } from "./tracing";

type InvoiceLine = { id: string; description: string };
type ShipmentDetails = { shipment: { rush: number }; lines: InvoiceLine[] };

const settings = process.env;
const shipmentId = String(settings.SHIPMENT);

// A tool span names the tool and the policy decision. It never copies the tool's input or
// output: those hold invoice text and prices, which must not leave the system of record.
async function tracedTool<Body>(parent: Span, name: string, input: object) {
  console.log(`tool call under ${parent.name}`);
  const span = startSpan(`execute_tool ${name}`, undefined, {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": name,
  });
  const answer: ToolAnswer<Body> = await callTool<Body>(name, input);
  span.attributes["policy.decision"] = answer.decision;
  endSpan(span);
  return answer;
}

// A model span names the role asked for and the tokens the gateway counted.
async function tracedModel<Answer>(parent: Span, task: string, prompt: string) {
  const span = startSpan("chat smart", parent, {
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "smart",
  });
  const reply = await askModel<Answer>("smart", task, prompt);
  span.attributes["gen_ai.usage.input_tokens"] = reply.tokensIn;
  span.attributes["gen_ai.usage.output_tokens"] = reply.tokensOut;
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
const run = startSpan(`invoke_agent ${settings.AGENT}`, undefined, {
  "gen_ai.operation.name": "invoke_agent",
  "gen_ai.agent.name": String(settings.AGENT),
});
run.baggage = {
  tenant: String(settings.IMPORTER),
  team: "classification",
  run_id: String(settings.RUN_ID),
};

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

// The policy engine. It asks Cedar one question: may this agent call this tool?
// POST /decide { agent, tool, importer, brokerSigned } answers { decision, reason }.
// The rules live in policy.cedar, outside any prompt, so a model cannot talk its way past them.
import { readFileSync } from "node:fs";
import { isAuthorized, validate } from "@cedar-policy/cedar-wasm/nodejs";

type Question = { agent: string; tool: string; importer: string; brokerSigned?: boolean };
type Answer = { decision: "allow" | "deny"; reason: string };

const policyText = readFileSync("policy.cedar", "utf8");
const schemaText = readFileSync("schema.cedarschema", "utf8");

// Cedar checks the policy against the schema once, when the engine starts. A policy that names
// a tool the schema does not know gets a problem here, and then every call is refused.
const schemaProblem = findSchemaProblem();

function findSchemaProblem(): string | undefined {
  const answer = validate({
    schema: schemaText,
    policies: { staticPolicies: policyText },
    validationSettings: { mode: "strict" },
  });
  if (answer.type === "failure") return answer.errors[0]?.message ?? "Cedar could not read it";
  if (answer.validationErrors.length > 0) return answer.validationErrors[0].error.message;
  return undefined;
}

// Ask Cedar whether this agent may call this tool, with or without a broker's signature.
function cedarAllows(question: Question, brokerSigned: boolean): boolean {
  const answer = isAuthorized({
    principal: { type: "Agent", id: question.agent },
    action: { type: "Action", id: question.tool },
    resource: { type: "Importer", id: question.importer },
    context: { brokerSigned },
    policies: { staticPolicies: policyText },
    entities: [],
  });
  if (answer.type === "failure") throw new Error(answer.errors[0]?.message ?? "Cedar failed");
  return answer.response.decision === "allow";
}

// Cedar has no "ask". A call that is allowed only with a broker's signature is an ask:
// it is refused now, and the reason says a broker must sign first.
function decide(question: Question): Answer {
  try {
    if (schemaProblem) throw new Error(`the policy file is not valid: ${schemaProblem}`);
    const signed = question.brokerSigned === true;
    if (cedarAllows(question, signed)) {
      return { decision: "allow", reason: `allowed: ${question.agent} may call ${question.tool}` };
    }
    if (!signed && cedarAllows(question, true)) {
      const reason = `ask: a licensed broker must sign before ${question.tool} runs`;
      return { decision: "deny", reason };
    }
    const reason = `denied: ${question.agent} may not call ${question.tool}`;
    return { decision: "deny", reason };
  } catch (error) {
    // If Cedar cannot decide, the call is refused. Never allow by mistake.
    const detail = (error as Error).message;
    return { decision: "deny", reason: `denied: the policy engine could not decide: ${detail}` };
  }
}

async function handleRequest(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ ok: true });
  if (path === "/decide" && request.method === "POST") {
    const question = (await request.json()) as Question;
    return Response.json(decide(question));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

Bun.serve({ port: Number(process.env.PORT ?? 4150), hostname: "127.0.0.1", fetch: handleRequest });

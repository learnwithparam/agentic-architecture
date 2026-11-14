// The policy engine. It asks Cedar one question: may this agent call this tool?
// POST /decide { agent, tool, importer, brokerSigned } answers { decision, reason }.
// The rules live in policy.cedar, outside any prompt, so a model cannot talk its way past them.
import { readFileSync } from "node:fs";
import { isAuthorized } from "@cedar-policy/cedar-wasm/nodejs";

type Question = { agent: string; tool: string; importer: string; brokerSigned?: boolean };
type Answer = { decision: "allow" | "deny"; reason: string };

const policyText = readFileSync("policy.cedar", "utf8");

// TODO: read schema.cedarschema, import validate from the same package, and call validate()
// with the schema and policyText here. Set schemaProblem to the first error it reports.
// Until then, every policy looks valid.
const schemaProblem: string | undefined = undefined;

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

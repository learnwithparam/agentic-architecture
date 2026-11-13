// The policy engine: it answers one question. May this agent call this tool?
// POST /decide { agent, tool, importer } answers { decision: "allow" | "ask" | "deny", reason }.
// The rules live in policy.yaml, outside any prompt, so a model cannot talk its way past them.
import { readFileSync } from "node:fs";

type AgentRules = { allow?: string[]; ask?: string[] };
type Question = { agent: string; tool: string; importer: string };

const policy = Bun.YAML.parse(readFileSync("policy.yaml", "utf8")) as {
  agents: Record<string, AgentRules>;
};

// "*" in a list means every tool.
function listNames(tools: string[] | undefined, tool: string): boolean {
  if (!tools) return false;
  return tools.includes(tool) || tools.includes("*");
}

// Anything the rules do not name is denied. That is what "deny by default" means.
function decide(question: Question) {
  const rules = policy.agents[question.agent];
  if (!rules) {
    return { decision: "deny", reason: `denied: ${question.agent} is not a registered agent` };
  }
  if (listNames(rules.ask, question.tool)) {
    const reason = `ask: a licensed broker must sign before ${question.tool} runs`;
    return { decision: "ask", reason };
  }
  if (listNames(rules.allow, question.tool)) {
    return { decision: "allow", reason: `allowed: ${question.agent} may call ${question.tool}` };
  }
  return { decision: "deny", reason: `denied: ${question.agent} may not call ${question.tool}` };
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

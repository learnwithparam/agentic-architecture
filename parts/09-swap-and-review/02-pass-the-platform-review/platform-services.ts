// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// The platform services for the review: the token service (agent identity), the tool gateway
// (policy, tenant scoping, audit) and the run journal (durable steps).
// The same code as reference/services.ts, except that it reads the team list and the policy
// from TEAMS_FILE and POLICY_FILE. So a new team joins by changing data, never this code.
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { jwtVerify, SignJWT } from "jose";

type Team = { team: string; agent: string; key: string };
// Which tools each agent may call, for example "holds-agent": ["list_holds", "pay_fee", ...].
type Policy = Record<string, string[]>;
type ToolInput = {
  shipment_id?: string;
  idempotency_key?: string;
  lines?: { line_id: string; code: string }[];
};
type Proposal = { line: string; code: string; broker: string | null };
type Caller = { agent: string; team: string };

const settings = process.env;
// A path next to this file, for the journal.
const nextToThisFile = (path: string) => new URL(path, import.meta.url).pathname;
const readDataFile = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const teams: Team[] = readDataFile(settings.TEAMS_FILE ?? "teams.json");
const policy: Policy = readDataFile(settings.POLICY_FILE ?? "policy.json");
// A fresh signing secret on every start: tokens from an earlier run stop working.
const secret = crypto.getRandomValues(new Uint8Array(32));
const AUDIENCE = "harbourgate-tools";

const journalPath = settings.JOURNAL_DB ?? nextToThisFile("../../../world/state/platform.db");
mkdirSync(dirname(journalPath), { recursive: true });
const journal = new Database(journalPath, { create: true });
journal.exec(
  "CREATE TABLE IF NOT EXISTS steps (run TEXT, step TEXT, result TEXT, PRIMARY KEY (run, step))",
);

function deny(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

// The ledger is a record, not a gate: if it is down, the tool call still goes ahead.
async function recordSpan(span: object): Promise<void> {
  const request = { method: "POST", body: JSON.stringify(span) };
  await fetch(`${settings.LEDGER_URL}/spans`, request).catch(() => undefined);
}

function callWorldTool(tool: string, input: object, headers: Record<string, string>) {
  const request = { method: "POST", body: JSON.stringify(input), headers };
  return fetch(`${settings.WORLD_URL}/tools/${tool}`, request);
}

const bearerToken = (request: Request) =>
  (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

// Customs takes any filing, so the platform checks that a licensed broker signed every line.
async function unsignedLinesProblem(input: ToolInput, importer: string) {
  const headers = { "x-agent": "tool-gateway", "x-importer": importer };
  const worldResponse = await callWorldTool(
    "read_proposals",
    { shipment_id: input.shipment_id },
    headers,
  );
  const { proposals }: { proposals: Proposal[] } = await worldResponse.json();
  const signedProposals = proposals.filter((proposal) => proposal.broker);
  const signedCodeByLine = new Map(
    signedProposals.map((proposal) => [proposal.line, proposal.code]),
  );
  const lines = input.lines ?? [];
  const unsigned = lines.filter((line) => signedCodeByLine.get(line.line_id) !== line.code);
  if (lines.length > 0 && unsigned.length === 0) return null;
  const howMany = unsigned.length || "every";
  return `ask: a licensed broker must sign ${howMany} line(s) before filing`;
}

// Returns why a tool call is refused, or null when it may go ahead.
async function refusalReason(caller: Caller, tool: string, input: ToolInput, importer: string) {
  const allowedTools = policy[caller.agent] ?? [];
  if (!allowedTools.includes(tool)) return `denied: ${caller.agent} may not call ${tool}`;
  if (tool === "pay_fee" && !input.idempotency_key) {
    return "denied: pay_fee needs an idempotency_key";
  }
  if (tool === "file_entry") return unsignedLinesProblem(input, importer);
  return null;
}

// The token service: an agent trades its secret for a short-lived signed token.
async function issueToken(request: Request): Promise<Response> {
  const login: { agent: string; secret: string } = await request.json();
  const team = teams.find((known) => known.agent === login.agent && known.key === login.secret);
  if (!team) return deny(401, "unknown agent or wrong secret");
  const token = await new SignJWT({ team: team.team })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(team.agent)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
  return Response.json({ token });
}

async function verifiedCaller(request: Request): Promise<Caller | null> {
  try {
    const verified = await jwtVerify(bearerToken(request), secret, { audience: AUDIENCE });
    return { agent: String(verified.payload.sub), team: String(verified.payload.team) };
  } catch {
    return null;
  }
}

// The tool gateway: who is asking, for which importer, and may they?
async function handleToolCall(request: Request, tool: string): Promise<Response> {
  const caller = await verifiedCaller(request);
  if (!caller) return deny(401, "denied: no valid agent token");
  const importer = request.headers.get("x-importer");
  if (!importer) {
    return deny(400, "denied: every tool call names the importer it is for (x-importer)");
  }
  const run = request.headers.get("x-run") ?? "";
  const input: ToolInput = await request.json().catch(() => ({}));
  const refusal = await refusalReason(caller, tool, input, importer);
  const detail = { agent: caller.agent, decision: refusal ?? "allow" };
  await recordSpan({ run_id: run, kind: "tool", name: tool, team: caller.team, importer, detail });
  if (refusal) return deny(403, refusal);
  const headers = { "x-agent": caller.agent, "x-importer": importer, "x-run": run };
  const worldResponse = await callWorldTool(tool, input, headers);
  return new Response(worldResponse.body, {
    status: worldResponse.status,
    headers: { "content-type": "application/json" },
  });
}

// The run journal: a finished step's result, saved so a restarted worker skips it.
async function handleJournal(request: Request, run: string, step: string) {
  if (request.method === "GET") {
    const row = journal
      .query("SELECT result FROM steps WHERE run = ? AND step = ?")
      .get(run, step) as { result: string } | null;
    if (!row) return deny(404, "step not done");
    return new Response(row.result, { headers: { "content-type": "application/json" } });
  }
  const saveStep = journal.prepare("INSERT OR REPLACE INTO steps VALUES (?,?,?)");
  saveStep.run(run, step, await request.text());
  return Response.json({ saved: true });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const isPost = request.method === "POST";
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname === "/token" && isPost) return issueToken(request);
  const tool = url.pathname.match(/^\/tools\/([a-z_]+)$/)?.[1];
  if (tool && isPost) return handleToolCall(request, tool);
  const journalPathParts = url.pathname.match(/^\/runs\/([^/]+)\/steps\/([^/]+)$/);
  const isJournalMethod = request.method === "GET" || request.method === "PUT";
  if (journalPathParts && isJournalMethod) {
    return handleJournal(request, journalPathParts[1], journalPathParts[2]);
  }
  return deny(404, "not found");
}

const server = Bun.serve({
  port: Number(settings.PORT ?? 4100),
  hostname: "127.0.0.1",
  fetch: handleRequest,
});
console.log(`platform services listening on ${server.port}`);

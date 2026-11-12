// The rest of the finished platform in one process: the token service (agent identity),
// the tool gateway (catalog, policy, tenant scoping, audit) and the run journal (durable steps).
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { jwtVerify, SignJWT } from "jose";

const env = process.env;
const here = (f: string) => new URL(f, import.meta.url).pathname;
const teams: any[] = JSON.parse(readFileSync(here("../world/data/teams.json"), "utf8"));
const policy = JSON.parse(readFileSync(here("./policy.json"), "utf8"));
const secret = crypto.getRandomValues(new Uint8Array(32));
const AUD = "harbourgate-tools";
const journalPath = env.JOURNAL_DB ?? here("../world/state/platform.db");
mkdirSync(dirname(journalPath), { recursive: true });
const journal = new Database(journalPath, { create: true });
journal.exec(
  "CREATE TABLE IF NOT EXISTS steps (run TEXT, step TEXT, result TEXT, PRIMARY KEY (run, step))",
);

const deny = (status: number, message: string) => Response.json({ error: message }, { status });
const span = (body: object) =>
  fetch(`${env.LEDGER_URL}/spans`, { method: "POST", body: JSON.stringify(body) }).catch(
    () => undefined,
  );
const world = (tool: string, body: object, headers: Record<string, string>) =>
  fetch(`${env.WORLD_URL}/tools/${tool}`, { method: "POST", body: JSON.stringify(body), headers });

async function decide(
  agent: string,
  tool: string,
  body: any,
  importer: string,
): Promise<string | null> {
  if (!(policy[agent] ?? []).includes(tool)) return `denied: ${agent} may not call ${tool}`;
  if (tool === "pay_fee" && !body.idempotency_key)
    return "denied: pay_fee needs an idempotency_key";
  if (tool === "file_entry") {
    const r: any = await (
      await world(
        "read_proposals",
        { shipment_id: body.shipment_id },
        { "x-agent": "tool-gateway", "x-importer": importer },
      )
    ).json();
    const signed = new Map(
      r.proposals.filter((p: any) => p.broker).map((p: any) => [p.line, p.code]),
    );
    const unsigned = (body.lines ?? []).filter((l: any) => signed.get(l.line_id) !== l.code);
    if (!body.lines?.length || unsigned.length)
      return `ask: a licensed broker must sign ${unsigned.length || "every"} line(s) before filing`;
  }
  return null;
}

const server = Bun.serve({
  port: Number(env.PORT ?? 4100),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/token" && req.method === "POST") {
      const b: any = await req.json();
      const t = teams.find((x) => x.agent === b.agent && x.key === b.secret);
      if (!t) return deny(401, "unknown agent or wrong secret");
      const token = await new SignJWT({ team: t.team })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(t.agent)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(secret);
      return Response.json({ token });
    }
    const tool = url.pathname.match(/^\/tools\/([a-z_]+)$/)?.[1];
    if (tool && req.method === "POST") {
      let agent: string, team: string;
      try {
        const { payload } = await jwtVerify(
          (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""),
          secret,
          { audience: AUD },
        );
        agent = String(payload.sub);
        team = String(payload.team);
      } catch {
        return deny(401, "denied: no valid agent token");
      }
      const importer = req.headers.get("x-importer");
      if (!importer)
        return deny(400, "denied: every tool call names the importer it is for (x-importer)");
      const run = req.headers.get("x-run") ?? "";
      const body: any = await req.json().catch(() => ({}));
      const no = await decide(agent, tool, body, importer);
      await span({
        run_id: run,
        kind: "tool",
        name: tool,
        team,
        importer,
        detail: { agent, decision: no ?? "allow" },
      });
      if (no) return deny(403, no);
      const r = await world(tool, body, { "x-agent": agent, "x-importer": importer, "x-run": run });
      return new Response(r.body, {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }
    const step = url.pathname.match(/^\/runs\/([^/]+)\/steps\/([^/]+)$/);
    if (step && req.method === "GET") {
      const row = journal
        .query("SELECT result FROM steps WHERE run = ? AND step = ?")
        .get(step[1], step[2]) as any;
      return row
        ? new Response(row.result, { headers: { "content-type": "application/json" } })
        : deny(404, "step not done");
    }
    if (step && req.method === "PUT") {
      journal
        .prepare("INSERT OR REPLACE INTO steps VALUES (?,?,?)")
        .run(step[1], step[2], await req.text());
      return Response.json({ saved: true });
    }
    return deny(404, "not found");
  },
});
console.log(`platform services listening on ${server.port}`);

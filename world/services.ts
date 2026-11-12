// The world's running services: the tools and ledger API (customs, documents, payments) and two fake
// model providers that answer from recorded replies. Checks and scripts start them in-process.
import type { Database } from "bun:sqlite";
import { data, openDb, resetDb } from "./db";

type Json = Record<string, any>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const PROVIDERS = data<any>("providers");
const REPLIES: Record<string, string> = require("./replay/replies.json");
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

export function priceOf(provider: string, role: string, tin: number, tout: number) {
  const p = PROVIDERS.providers[provider].prices[role];
  return tin * p.in + tout * p.out;
}

function keyOwner(provider: string, key: string): string | null {
  if (PROVIDERS.providers[provider]?.platform_key === key) return "platform";
  if (provider === "a")
    for (const [team, k] of Object.entries(PROVIDERS.legacy_keys))
      if (k === key) return `team:${team}`;
  return null;
}

// One fake provider. It speaks the OpenAI chat completions shape, checks its key, bills every call
// in provider_calls (its own invoice), and can be taken down to test fallback.
export function startProvider(db: Database, name: "a" | "b") {
  const state = { down: false };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return json({ ok: !state.down });
      if (url.pathname !== "/v1/chat/completions" || req.method !== "POST")
        return json({ error: { message: "not found" } }, 404);
      const owner = keyOwner(
        name,
        (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""),
      );
      if (!owner) return json({ error: { message: "invalid provider key" } }, 401);
      if (state.down) {
        db.prepare(
          "INSERT INTO provider_calls (provider, key_owner, role, tokens_in, tokens_out, cost_micros, status) VALUES (?,?,?,?,?,?,?)",
        ).run(name, owner, null, 0, 0, 0, 503);
        return json({ error: { message: "provider unavailable" } }, 503);
      }
      const body = (await req.json()) as Json;
      const role = String(body.model ?? "").replace(/^replay-/, "");
      if (!PROVIDERS.providers[name].prices[role])
        return json({ error: { message: `unknown model "${body.model}"` } }, 400);
      const msgs: Json[] = body.messages ?? [];
      const text = msgs
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      const task = text.match(/TASK ([a-z]+:[A-Za-z0-9-]+)/)?.[1];
      const reply = task ? REPLIES[`${role}|${task}`] : undefined;
      if (reply === undefined)
        return json(
          {
            error: {
              message: `no recorded reply for ${role} ${task ?? "(no TASK line)"}; record one or use a live provider`,
            },
          },
          404,
        );
      const tin = tokens(text),
        tout = tokens(reply);
      const cost = priceOf(name, role, tin, tout);
      db.prepare(
        "INSERT INTO provider_calls (provider, key_owner, role, tokens_in, tokens_out, cost_micros, status) VALUES (?,?,?,?,?,?,?)",
      ).run(name, owner, role, tin, tout, cost, 200);
      return json({
        id: `chatcmpl-${name}-${Bun.hash(text + Math.random()).toString(16)}`,
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: tin, completion_tokens: tout, total_tokens: tin + tout },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, state, stop: () => server.stop(true) };
}

// The tools and ledger API. Headers x-agent, x-importer and x-run say who asked; the world records
// them in tool_audit and never checks them. Checking is the platform's job.
export function startWorldApi(db: Database) {
  const brokers = data<any[]>("brokers");
  const tariff = data<any>("tariff");
  const audit = (tool: string, h: Headers, outcome: string) =>
    db
      .prepare("INSERT INTO tool_audit (tool, agent, importer, run_id, outcome) VALUES (?,?,?,?,?)")
      .run(tool, h.get("x-agent"), h.get("x-importer"), h.get("x-run"), outcome);
  const shipment = (id: string) =>
    db.query("SELECT * FROM shipments WHERE id = ?").get(id) as Json | null;
  const readDocs = (docs: Json[], h: Headers, forImporter: string) => {
    const ins = db.prepare(
      "INSERT INTO reads (doc, doc_importer, for_importer, agent) VALUES (?,?,?,?)",
    );
    for (const d of docs) ins.run(d.id, d.importer, forImporter, h.get("x-agent"));
    return docs;
  };

  const tools: Record<string, (b: Json, h: Headers) => Json | [number, Json]> = {
    list_open_shipments: (b, h) => {
      const imp = h.get("x-importer") ?? b.importer;
      const rows = imp
        ? db
            .query(
              "SELECT id, importer, container, rush FROM shipments WHERE status = 'open' AND importer = ? ORDER BY id",
            )
            .all(imp)
        : db
            .query(
              "SELECT id, importer, container, rush FROM shipments WHERE status = 'open' ORDER BY id",
            )
            .all();
      return { shipments: rows };
    },
    read_shipment: (b, h) => {
      const s = shipment(b.shipment_id);
      if (!s) return [404, { error: `no shipment ${b.shipment_id}` }];
      const lines = db
        .query("SELECT id, description, qty, value_cents FROM lines WHERE shipment = ? ORDER BY id")
        .all(s.id);
      const docs = readDocs(
        db.query("SELECT * FROM documents WHERE shipment = ? ORDER BY id").all(s.id) as Json[],
        h,
        h.get("x-importer") ?? s.importer,
      );
      return { shipment: s, lines, documents: docs };
    },
    // Finds similar past documents. With no x-importer header it searches every importer's papers.
    search_documents: (b, h) => {
      const words = String(b.query ?? "")
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3);
      const imp = h.get("x-importer");
      const all = (
        imp
          ? db.query("SELECT * FROM documents WHERE importer = ?").all(imp)
          : db.query("SELECT * FROM documents").all()
      ) as Json[];
      const scored = all
        .map((d) => ({ d, score: words.filter((w) => d.body.toLowerCase().includes(w)).length }))
        .filter((x) => x.score > 0 && x.d.shipment !== b.shipment_id)
        .sort((x, y) => y.score - x.score || (x.d.id < y.d.id ? -1 : 1))
        .slice(0, 5)
        .map((x) => x.d);
      const forImp = imp ?? (b.shipment_id ? shipment(b.shipment_id)?.importer : null) ?? "unknown";
      return { documents: readDocs(scored, h, forImp) };
    },
    propose_code: (b, h) => {
      const line = db.query("SELECT * FROM lines WHERE id = ?").get(b.line_id) as Json | null;
      if (!line) return [404, { error: `no line ${b.line_id}` }];
      db.prepare("INSERT INTO proposals VALUES (?,?,?,?,?)").run(
        line.id,
        line.shipment,
        b.code,
        b.reason ?? "",
        h.get("x-agent"),
      );
      return { proposed: true };
    },
    read_proposals: (b) => ({
      proposals: db
        .query(
          "SELECT p.line, p.code, p.reason, s.broker FROM proposals p LEFT JOIN signatures s ON s.line = p.line AND s.code = p.code AND s.licence IS NOT NULL WHERE p.shipment = ? ORDER BY p.line",
        )
        .all(b.shipment_id),
    }),
    lookup_tariff: (b) => {
      const q = String(b.query ?? "").toLowerCase();
      return {
        codes: tariff.codes.filter((c: Json) =>
          q
            .split(/\W+/)
            .some((w: string) => w.length > 3 && c.description.toLowerCase().includes(w)),
        ),
      };
    },
    email_importer: (b, h) => {
      const s = shipment(b.shipment_id);
      if (!s) return [404, { error: `no shipment ${b.shipment_id}` }];
      db.prepare("INSERT INTO emails (shipment, importer, agent, message) VALUES (?,?,?,?)").run(
        s.id,
        s.importer,
        h.get("x-agent"),
        String(b.message ?? ""),
      );
      return { sent: true };
    },
    // Customs accepts any filing. Whether a broker signed is the platform's problem, as in real life.
    file_entry: (b, h) => {
      const s = shipment(b.shipment_id);
      if (!s) return [404, { error: `no shipment ${b.shipment_id}` }];
      if (s.status !== "open") return [409, { error: `${s.id} is already ${s.status}` }];
      const held = Boolean(s.exam_kind);
      const status = held ? "held" : "released";
      const id = Number(
        db
          .prepare("INSERT INTO entries (shipment, filed_by, status, run_id) VALUES (?,?,?,?)")
          .run(s.id, h.get("x-agent"), status, h.get("x-run")).lastInsertRowid,
      );
      for (const l of b.lines ?? []) {
        const sig = db
          .query(
            "SELECT broker FROM signatures WHERE line = ? AND code = ? AND licence IS NOT NULL",
          )
          .get(l.line_id, l.code) as Json | null;
        db.prepare("INSERT INTO entry_lines VALUES (?,?,?,?)").run(
          id,
          l.line_id,
          l.code,
          sig?.broker ?? null,
        );
      }
      db.prepare("UPDATE shipments SET status = ? WHERE id = ?").run(status, s.id);
      if (held)
        db.prepare("INSERT OR IGNORE INTO holds (shipment, kind, fee_cents) VALUES (?,?,?)").run(
          s.id,
          s.exam_kind,
          s.exam_fee_cents,
        );
      return {
        entry: id,
        status,
        hold: held ? { kind: s.exam_kind, fee_cents: s.exam_fee_cents } : null,
      };
    },
    list_holds: (b, h) => ({
      holds: db
        .query(
          "SELECT h.*, s.importer FROM holds h JOIN shipments s ON s.id = h.shipment WHERE h.released = 0 AND (?1 IS NULL OR s.importer = ?1) ORDER BY h.shipment",
        )
        .all(h.get("x-importer")),
    }),
    book_exam: (b) => {
      const r = db.prepare("UPDATE holds SET booked = 1 WHERE shipment = ?").run(b.shipment_id);
      return r.changes ? { booked: true } : [404, { error: `no hold on ${b.shipment_id}` }];
    },
    // Pays a fee. The same idempotency_key twice returns the first payment and moves no money.
    pay_fee: (b, h) => {
      if (b.idempotency_key) {
        const prev = db
          .query("SELECT id FROM payments WHERE idempotency_key = ?")
          .get(b.idempotency_key) as Json | null;
        if (prev) return { payment: prev.id, repeated: true };
      }
      const id = db
        .prepare(
          "INSERT INTO payments (shipment, purpose, amount_cents, idempotency_key, paid_by) VALUES (?,?,?,?,?)",
        )
        .run(
          b.shipment_id,
          b.purpose,
          b.amount_cents,
          b.idempotency_key ?? null,
          h.get("x-agent"),
        ).lastInsertRowid;
      return { payment: Number(id) };
    },
    check_release: (b) => {
      const hold = db
        .query("SELECT * FROM holds WHERE shipment = ?")
        .get(b.shipment_id) as Json | null;
      if (!hold) return { released: (shipment(b.shipment_id)?.status ?? "") === "released" };
      const paid = db
        .query("SELECT COUNT(*) AS n FROM payments WHERE shipment = ? AND purpose = 'exam_fee'")
        .get(b.shipment_id) as Json;
      if (hold.booked && paid.n > 0) {
        db.prepare("UPDATE holds SET released = 1 WHERE shipment = ?").run(b.shipment_id);
        db.prepare("UPDATE shipments SET status = 'released' WHERE id = ?").run(b.shipment_id);
        db.prepare("UPDATE entries SET status = 'released' WHERE shipment = ?").run(b.shipment_id);
        return { released: true };
      }
      return { released: false, waiting_for: hold.booked ? "exam fee" : "exam booking" };
    },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const h = req.headers;
      if (url.pathname === "/health") return json({ ok: true });
      const tool = url.pathname.match(/^\/tools\/([a-z_]+)$/)?.[1];
      if (tool && req.method === "POST") {
        const fn = tools[tool];
        if (!fn) return json({ error: `no tool ${tool}` }, 404);
        const out = fn(((await req.json().catch(() => ({}))) as Json) ?? {}, h);
        const [status, body] = Array.isArray(out) ? out : [200, out];
        audit(tool, h, status === 200 ? "ok" : `error ${status}`);
        return json(body, status);
      }
      // A licensed broker signs a proposed code. Signatures from people who are not licensed are refused.
      if (url.pathname === "/broker/sign" && req.method === "POST") {
        const b = (await req.json()) as Json;
        const who = brokers.find((x) => x.id === b.broker);
        if (!who) return json({ error: `no broker ${b.broker}` }, 404);
        if (!who.licensed)
          return json({ error: `${who.name} is not a licensed broker and may not sign` }, 403);
        db.prepare("INSERT INTO signatures VALUES (?,?,?,?)").run(
          b.line_id,
          b.code,
          who.id,
          who.licence,
        );
        return json({ signed: true, broker: who.id });
      }
      if (url.pathname === "/ledger/spend" && req.method === "POST") {
        const r = (await req.json()) as Json;
        db.prepare(
          "INSERT INTO spend_log (request_id, team, importer, role, provider, tokens_in, tokens_out, cost_micros, status, run_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(
          r.request_id ?? null,
          r.team ?? null,
          r.importer ?? null,
          r.role ?? null,
          r.provider ?? null,
          Number(r.tokens_in ?? 0),
          Number(r.tokens_out ?? 0),
          Number(r.cost_micros ?? 0),
          r.status ?? "ok",
          r.run_id ?? null,
        );
        return json({ recorded: true });
      }
      if (url.pathname === "/ledger/spend" && req.method === "GET") {
        const imp = url.searchParams.get("importer"),
          team = url.searchParams.get("team");
        const row = db
          .query(
            "SELECT COALESCE(SUM(cost_micros),0) AS total_micros, COUNT(*) AS rows FROM spend_log WHERE (?1 IS NULL OR importer = ?1) AND (?2 IS NULL OR team = ?2)",
          )
          .get(imp, team);
        return json(row);
      }
      if (url.pathname === "/ledger/spans" && req.method === "POST") {
        const r = (await req.json()) as Json;
        db.prepare(
          "INSERT INTO spans (run_id, kind, name, team, importer, detail) VALUES (?,?,?,?,?,?)",
        ).run(
          r.run_id ?? null,
          r.kind,
          r.name,
          r.team ?? null,
          r.importer ?? null,
          JSON.stringify(r.detail ?? {}),
        );
        return json({ recorded: true });
      }
      return json({ error: "not found" }, 404);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export type World = Awaited<ReturnType<typeof startWorld>>;

// Starts the whole world on free ports. reset: true rebuilds the database first.
export async function startWorld(opts: { db?: string; reset?: boolean } = {}) {
  const db = opts.reset ? resetDb(opts.db) : openDb(opts.db);
  const api = startWorldApi(db);
  const a = startProvider(db, "a");
  const b = startProvider(db, "b");
  return {
    db,
    api: api.url,
    providerA: a,
    providerB: b,
    env: {
      WORLD_URL: api.url,
      LEDGER_URL: `${api.url}/ledger`,
      PROVIDER_A_URL: a.url,
      PROVIDER_A_KEY: PROVIDERS.providers.a.platform_key,
      PROVIDER_B_URL: b.url,
      PROVIDER_B_KEY: PROVIDERS.providers.b.platform_key,
      REPLAY_URL: a.url,
      REPLAY_KEY: PROVIDERS.providers.a.platform_key,
    } as Record<string, string>,
    stop() {
      api.stop();
      a.stop();
      b.stop();
    },
  };
}

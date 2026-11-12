// The world and the finished platform behave as the README says, with no model key.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runAfter } from "../reference/after";
import { card, costs, LABELS } from "../world/report";
import { runBefore } from "../world/scenario";
import { startWorld } from "../world/services";

const ROOT = join(import.meta.dir, "..");
const STATE = join(ROOT, "world", "state");

describe("the world", () => {
  test("resets to 60 shipments with 12 open", async () => {
    const w = await startWorld({ db: join(STATE, "test-reset.db"), reset: true });
    try {
      expect((w.db.query("SELECT COUNT(*) AS n FROM shipments").get() as any).n).toBe(60);
      expect((w.db.query("SELECT COUNT(*) AS n FROM shipments WHERE status = 'open'").get() as any).n).toBe(12);
    } finally { w.stop(); }
  });

  test("a provider refuses a key it does not know and bills only what it answered", async () => {
    const w = await startWorld({ db: join(STATE, "test-provider.db"), reset: true });
    try {
      const call = (key: string) => fetch(`${w.providerA.url}/v1/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "replay-fast", messages: [{ role: "user", content: "TASK ping:1" }] }),
      });
      expect((await call("hgk_paperwork_b2c604")).status).toBe(401);
      expect((await call(w.env.PROVIDER_A_KEY)).status).toBe(200);
      expect((w.db.query("SELECT COUNT(*) AS n FROM provider_calls").get() as any).n).toBe(1);
    } finally { w.stop(); }
  });
});

describe("before and after", () => {
  test("the scripts as they are now break every line of the report card", async () => {
    const w = await startWorld({ db: join(STATE, "test-before.db"), reset: true });
    try {
      await runBefore(w, join(STATE, "test-before"));
      const c = card(w.db, join(ROOT, "world", "legacy"));
      for (const k of Object.keys(LABELS)) expect(c[k as keyof typeof c]).toBeGreaterThan(0);
    } finally { w.stop(); }
  }, 60000);

  test("the finished platform brings every line to zero and prices every importer", async () => {
    const w = await startWorld({ db: join(STATE, "test-after.db"), reset: true });
    try {
      await runAfter(w, join(STATE, "test-after"));
      const c = card(w.db, join(ROOT, "teams"));
      for (const k of Object.keys(LABELS)) expect(c[k as keyof typeof c]).toBe(0);
      for (const r of costs(w.db)) {
        expect(r.released).toBeGreaterThan(0);
        expect(r.spend_micros).toBeGreaterThan(0);
      }
      const spend = (w.db.query("SELECT SUM(cost_micros) AS c FROM spend_log").get() as any).c;
      const billed = (w.db.query("SELECT SUM(cost_micros) AS c FROM provider_calls").get() as any).c;
      expect(spend).toBe(billed);
    } finally { w.stop(); }
  }, 60000);
});

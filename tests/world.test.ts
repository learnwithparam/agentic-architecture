// The world and the finished platform behave as the README says, with no model key.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runAfter } from "../reference/after";
import { type Card, card, costs, LABELS } from "../world/report";
import { runBefore } from "../world/scenario";
import { startWorld } from "../world/services";

const ROOT = join(import.meta.dir, "..");
const STATE = join(ROOT, "world", "state");
const REPORT_CARD_LINES = Object.keys(LABELS) as (keyof Card)[];

// Ask the database for one number, named "total" in the SQL.
function numberFrom(database: Database, sql: string): number {
  const row = database.query(sql).get() as { total: number };
  return row.total;
}

describe("the world", () => {
  test("resets to 60 shipments with 12 open", async () => {
    const world = await startWorld({ db: join(STATE, "test-reset.db"), reset: true });
    try {
      expect(numberFrom(world.db, "SELECT COUNT(*) AS total FROM shipments")).toBe(60);
      const openShipments = numberFrom(
        world.db,
        "SELECT COUNT(*) AS total FROM shipments WHERE status = 'open'",
      );
      expect(openShipments).toBe(12);
    } finally {
      world.stop();
    }
  });

  test("a provider refuses a key it does not know and bills only what it answered", async () => {
    const world = await startWorld({ db: join(STATE, "test-provider.db"), reset: true });
    try {
      const callProviderA = (key: string) =>
        fetch(`${world.providerA.url}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "replay-fast",
            messages: [{ role: "user", content: "TASK ping:1" }],
          }),
        });
      const teamKey = "hgk_paperwork_b2c604";
      expect((await callProviderA(teamKey)).status).toBe(401);
      expect((await callProviderA(world.env.PROVIDER_A_KEY)).status).toBe(200);
      expect(numberFrom(world.db, "SELECT COUNT(*) AS total FROM provider_calls")).toBe(1);
    } finally {
      world.stop();
    }
  });
});

describe("before and after", () => {
  test("the scripts as they are now break every line of the report card", async () => {
    const world = await startWorld({ db: join(STATE, "test-before.db"), reset: true });
    try {
      await runBefore(world, join(STATE, "test-before"));
      const reportCard = card(world.db, join(ROOT, "world", "legacy"));
      for (const line of REPORT_CARD_LINES) expect(reportCard[line]).toBeGreaterThan(0);
    } finally {
      world.stop();
    }
  }, 60000);

  test("the finished platform brings every line to zero and prices every importer", async () => {
    const world = await startWorld({ db: join(STATE, "test-after.db"), reset: true });
    try {
      await runAfter(world, join(STATE, "test-after"));
      const reportCard = card(world.db, join(ROOT, "teams"));
      for (const line of REPORT_CARD_LINES) expect(reportCard[line]).toBe(0);
      for (const importerCosts of costs(world.db)) {
        expect(importerCosts.released).toBeGreaterThan(0);
        expect(importerCosts.spend_micros).toBeGreaterThan(0);
      }
      const spend = numberFrom(world.db, "SELECT SUM(cost_micros) AS total FROM spend_log");
      const billed = numberFrom(world.db, "SELECT SUM(cost_micros) AS total FROM provider_calls");
      expect(spend).toBe(billed);
    } finally {
      world.stop();
    }
  }, 60000);
});

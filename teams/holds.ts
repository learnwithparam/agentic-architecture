// Holds agent: books the exam, pays the fee once and waits for release. Each action is a durable
// step, so a worker that dies after paying picks up at the next step and never pays twice.
import { existsSync, writeFileSync } from "node:fs";
import { ask, IMPORTERS, step, tool } from "./lib/platform";

for (const importer of IMPORTERS) {
  const { body } = await tool("list_holds", {}, importer);
  for (const h of body.holds) {
    await step(`plan:${h.shipment}`, () =>
      ask("fast", `hold:${h.shipment}`, "Plan the hold.", importer),
    );
    await step(
      `book_exam:${h.shipment}`,
      async () => (await tool("book_exam", { shipment_id: h.shipment }, importer)).body,
    );
    await step(
      `pay_exam_fee:${h.shipment}`,
      async () =>
        (
          await tool(
            "pay_fee",
            {
              shipment_id: h.shipment,
              purpose: "exam_fee",
              amount_cents: h.fee_cents,
              idempotency_key: `${process.env.RUN_ID}:exam_fee:${h.shipment}`,
            },
            importer,
          )
        ).body,
    );
    const marker = `${process.env.STATE_DIR}/worker-crashed`;
    if (process.env.CRASH_AFTER === "pay_exam_fee" && !existsSync(marker)) {
      writeFileSync(marker, "worker died after paying\n");
      process.exit(137);
    }
    await step(
      `wait_for_release:${h.shipment}`,
      async () => (await tool("check_release", { shipment_id: h.shipment }, importer)).body,
    );
  }
}

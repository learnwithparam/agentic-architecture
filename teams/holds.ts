// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// Holds agent: books the exam, pays the fee once and waits for release. Each action is a durable
// step, so a worker that dies after paying picks up at the next step and never pays twice.
import { existsSync, writeFileSync } from "node:fs";
import { ask, IMPORTERS, step, tool } from "./lib/platform";

type Hold = { shipment: string; fee_cents: number };

async function toolBody(name: string, input: object, importer: string): Promise<unknown> {
  const result = await tool(name, input, importer);
  return result.body;
}

async function payExamFee(hold: Hold, importer: string): Promise<unknown> {
  // The same key on a retry tells the payments service this fee is already paid.
  const idempotencyKey = `${process.env.RUN_ID}:exam_fee:${hold.shipment}`;
  const payment = {
    shipment_id: hold.shipment,
    purpose: "exam_fee",
    amount_cents: hold.fee_cents,
    idempotency_key: idempotencyKey,
  };
  return toolBody("pay_fee", payment, importer);
}

// The crash drill: the worker dies once, right after paying, to prove the fee is never paid twice.
function crashOnceAfterPaying(): void {
  const marker = `${process.env.STATE_DIR}/worker-crashed`;
  if (process.env.CRASH_AFTER === "pay_exam_fee" && !existsSync(marker)) {
    writeFileSync(marker, "worker died after paying\n");
    process.exit(137);
  }
}

async function clearHold(hold: Hold, importer: string): Promise<void> {
  const shipmentOnly = { shipment_id: hold.shipment };
  await step(`plan:${hold.shipment}`, () =>
    ask("fast", `hold:${hold.shipment}`, "Plan the hold.", importer),
  );
  await step(`book_exam:${hold.shipment}`, () => toolBody("book_exam", shipmentOnly, importer));
  await step(`pay_exam_fee:${hold.shipment}`, () => payExamFee(hold, importer));
  crashOnceAfterPaying();
  await step(`wait_for_release:${hold.shipment}`, () =>
    toolBody("check_release", shipmentOnly, importer),
  );
}

for (const importer of IMPORTERS) {
  const holds = await tool<{ holds: Hold[] }>("list_holds", {}, importer);
  for (const hold of holds.body.holds) await clearHold(hold, importer);
}

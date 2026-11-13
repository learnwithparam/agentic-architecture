// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// The Holds worker. For each container customs holds: plan, book the exam, pay the fee,
// and wait for release. Each of those is a durable step in the journal.
import { crashDrill } from "./crash-drill";
import { step } from "./journal";
import { askModel, callTool } from "./platform-client";

type Hold = { shipment: string; fee_cents: number };

const IMPORTERS = ["fjordline", "ridgeway", "northpoint"];

async function bookExam(hold: Hold, importer: string): Promise<unknown> {
  const answer = await callTool("book_exam", { shipment_id: hold.shipment }, importer);
  return answer.body;
}

async function payExamFee(hold: Hold, importer: string): Promise<unknown> {
  const payment = {
    shipment_id: hold.shipment,
    purpose: "exam_fee",
    amount_cents: hold.fee_cents,
    // The payments service wants a key on every payment. A new key each time is fixed later.
    idempotency_key: crypto.randomUUID(),
  };
  const answer = await callTool("pay_fee", payment, importer);
  return answer.body;
}

async function waitForRelease(hold: Hold, importer: string): Promise<unknown> {
  const answer = await callTool("check_release", { shipment_id: hold.shipment }, importer);
  return answer.body;
}

async function clearHold(hold: Hold, importer: string): Promise<void> {
  const shipment = hold.shipment;
  await step(`plan:${shipment}`, () => askModel(`hold:${shipment}`, "Plan the hold.", importer));
  await step(`book_exam:${shipment}`, () => bookExam(hold, importer));
  await step(`pay_exam_fee:${shipment}`, () => payExamFee(hold, importer));
  crashDrill("pay_exam_fee");
  await step(`wait_for_release:${shipment}`, () => waitForRelease(hold, importer));
}

for (const importer of IMPORTERS) {
  const holds = await callTool<{ holds: Hold[] }>("list_holds", {}, importer);
  for (const hold of holds.body.holds) await clearHold(hold, importer);
}

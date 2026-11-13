// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// The two steps of the Holds worker that move state, as Temporal activities.
// They call the same tools as holds.ts in the survive-a-crash part. No new logic.
import { crashDrill } from "./crash-drill";
import { callTool } from "./platform-client";
import type { Hold } from "./workflow";

export async function bookExam(hold: Hold): Promise<unknown> {
  const answer = await callTool("book_exam", { shipment_id: hold.shipment }, hold.importer);
  return answer.body;
}

export async function payExamFee(hold: Hold): Promise<unknown> {
  // The drill kills the worker here: the booking is saved, the payment has not started.
  crashDrill("pay_exam_fee");
  const payment = {
    shipment_id: hold.shipment,
    purpose: "exam_fee",
    amount_cents: hold.fee_cents,
    // One key per shipment, so a second try can never pay twice.
    idempotency_key: `${hold.shipment}-exam-fee`,
  };
  const answer = await callTool("pay_fee", payment, hold.importer);
  return answer.body;
}

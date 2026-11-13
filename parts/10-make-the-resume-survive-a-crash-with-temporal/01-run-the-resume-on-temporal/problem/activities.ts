// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// The two steps of the Holds worker, as Temporal activities. Fill them in.
// Use callTool for book_exam and pay_fee, as holds.ts does in the survive-a-crash part.
// Keep crashDrill("pay_exam_fee") at the top of payExamFee. Do not change crash-drill.ts.
import type { Hold } from "./workflow";

export async function bookExam(hold: Hold): Promise<unknown> {
  throw new Error(`TODO: book the exam for ${hold.shipment}`);
}

export async function payExamFee(hold: Hold): Promise<unknown> {
  throw new Error(`TODO: pay the fee for ${hold.shipment}`);
}

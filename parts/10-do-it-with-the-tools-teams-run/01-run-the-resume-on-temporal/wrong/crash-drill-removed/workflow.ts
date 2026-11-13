// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// The Holds run as a Temporal workflow. Temporal saves the history of each finished activity,
// so a worker that starts again goes on from the next one. This replaces journal.ts.
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";

export type Hold = { shipment: string; importer: string; fee_cents: number };

// A worker that dies mid-activity is noticed after this long, and the activity runs again.
const { bookExam, payExamFee } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 seconds",
});

export async function clearHold(hold: Hold): Promise<string> {
  await bookExam(hold);
  await payExamFee(hold);
  return `cleared ${hold.shipment}`;
}

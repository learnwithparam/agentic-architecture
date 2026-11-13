// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// The Holds run as a Temporal workflow. Fill in the two steps as activities.
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";

export type Hold = { shipment: string; importer: string; fee_cents: number };

// TODO: call each activity from clearHold, in order, with this proxy.
const { bookExam, payExamFee } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 seconds",
});

export async function clearHold(hold: Hold): Promise<string> {
  return `not started ${hold.shipment} ${typeof bookExam} ${typeof payExamFee}`;
}

// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";

export type Hold = { shipment: string; importer: string; fee_cents: number };

const { bookAndPay } = proxyActivities<typeof activities>({ startToCloseTimeout: "5 seconds" });

export async function clearHold(hold: Hold): Promise<string> {
  await bookAndPay(hold);
  return `cleared ${hold.shipment}`;
}

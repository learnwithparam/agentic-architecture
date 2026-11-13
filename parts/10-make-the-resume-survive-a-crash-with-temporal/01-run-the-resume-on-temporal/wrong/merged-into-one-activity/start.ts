// biome-ignore-all lint/style/useNamingConvention: settings like TASK_QUEUE are in capitals.
// Start one Holds run and wait for it. Open http://localhost:8233 to watch it.
import { Client, Connection } from "@temporalio/client";
import type { Hold } from "./workflow";

const hold: Hold = { shipment: "HG-1050", importer: "ridgeway", fee_cents: 25000 };
const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
});
const client = new Client({ connection });
const handle = await client.workflow.start("clearHold", {
  taskQueue: process.env.TASK_QUEUE ?? "holds",
  workflowId: process.env.WORKFLOW_ID ?? `holds-${Date.now()}`,
  args: [hold],
});
console.log(`started ${handle.workflowId}`);
console.log(await handle.result());

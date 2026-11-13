// biome-ignore-all lint/style/useNamingConvention: settings like TASK_QUEUE are in capitals.
// The worker: it runs the workflow's steps. Kill it and start it again, and the run goes on.
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
});
const worker = await Worker.create({
  connection,
  taskQueue: process.env.TASK_QUEUE ?? "holds",
  workflowsPath: new URL("./workflow.ts", import.meta.url).pathname,
  activities,
});
console.log("worker ready");
await worker.run();

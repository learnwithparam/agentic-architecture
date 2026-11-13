// biome-ignore-all lint/style/useNamingConvention: the tools name their fields in snake_case.
// The Holds worker. For each container customs holds: plan, book the exam, pay the fee,
// and wait for release. Each of those is a durable step in the journal.
// A container that is still held after free time gets one page to a broker, with the reason.
import { crashDrill } from "./crash-drill";
import { step } from "./journal";
import { askModel, callTool } from "./platform-client";

type Hold = { shipment: string; fee_cents: number };
type Release = { released?: boolean; waiting_for?: string };

const settings = process.env;
const IMPORTERS = ["fjordline", "ridgeway", "northpoint"];
// How many times to ask customs before free time runs out, and how long to pause in between.
const RELEASE_CHECKS = Number(settings.RELEASE_CHECKS ?? 5);
const RELEASE_PAUSE_MS = Number(settings.RELEASE_PAUSE_MS ?? 1000);

async function bookExam(hold: Hold, importer: string): Promise<unknown> {
  const answer = await callTool("book_exam", { shipment_id: hold.shipment }, importer);
  return answer.body;
}

async function payExamFee(hold: Hold, importer: string): Promise<unknown> {
  const payment = {
    shipment_id: hold.shipment,
    purpose: "exam_fee",
    amount_cents: hold.fee_cents,
    // The same run, the same fee, the same container: always the same key.
    // So a second try, or a replay of the whole run, is refused by the payments service.
    idempotency_key: `${settings.RUN_ID}:exam_fee:${hold.shipment}`,
  };
  const answer = await callTool("pay_fee", payment, importer);
  return answer.body;
}

// Ask customs again and again until the container is released.
async function waitForRelease(hold: Hold, importer: string): Promise<Release> {
  let release: Release = {};
  console.log(`waiting for ${hold.shipment}, up to ${RELEASE_CHECKS} checks were planned`);
  while (true) {
    const shipmentOnly = { shipment_id: hold.shipment };
    const answer = await callTool<Release>("check_release", shipmentOnly, importer);
    release = answer.body;
    if (release.released) return release;
    await Bun.sleep(RELEASE_PAUSE_MS);
  }
}

// A person must act when a container sits past free time: every extra day costs demurrage.
async function pageBroker(hold: Hold, release: Release): Promise<unknown> {
  const waitingFor = release.waiting_for ?? "customs";
  const reason = `demurrage: ${hold.shipment} is held after free time, waiting for ${waitingFor}`;
  const page = { shipment: hold.shipment, run_id: settings.RUN_ID, reason };
  const request = { method: "POST", body: JSON.stringify(page) };
  const response = await fetch(String(settings.PAGER_URL), request);
  return { paged: response.ok, reason };
}

async function clearHold(hold: Hold, importer: string): Promise<void> {
  const shipment = hold.shipment;
  await step(`plan:${shipment}`, () => askModel(`hold:${shipment}`, "Plan the hold.", importer));
  await step(`book_exam:${shipment}`, () => bookExam(hold, importer));
  await step(`pay_exam_fee:${shipment}`, () => payExamFee(hold, importer));
  crashDrill("pay_exam_fee");
  const release = await step(`wait_for_release:${shipment}`, () => waitForRelease(hold, importer));
  if (release.released) return;
  // The page is a step too, so a worker that starts again does not page the broker twice.
  await step(`page_broker:${shipment}`, () => pageBroker(hold, release));
}

for (const importer of IMPORTERS) {
  const holds = await callTool<{ holds: Hold[] }>("list_holds", {}, importer);
  for (const hold of holds.body.holds) await clearHold(hold, importer);
}

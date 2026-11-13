// Show the platform review's report card, by hand. It onboards Billing on copies of your data
// files, runs the open queue and the Billing agent on your platform, and prints what the
// ledger shows. Your own files are not changed.
//
//   bun parts/09-swap-and-review/02-pass-the-platform-review/review-card.ts            (your work)
//   bun parts/09-swap-and-review/02-pass-the-platform-review/review-card.ts solution   (the sample)
import { join } from "node:path";
import { reviewThePlatform } from "../../../checks/pass-the-platform-review";
import { type Card, LABELS } from "../../../world/report";

const folderName = process.argv[2] ?? "problem";
const review = await reviewThePlatform(join(import.meta.dir, folderName));
console.log("Harbourgate on your platform, with Billing on board:");
for (const [field, label] of Object.entries(LABELS)) {
  const count = String(review.finalCard[field as keyof Card]);
  console.log(`  ${count.padStart(4)}  ${label}`);
}
const billing = review.evidence;
console.log("  Billing team:");
console.log(`    ${billing.billedCalls} model call(s) billed to billing`);
console.log(`    ${billing.toolCalls} tool call(s) recorded as billing-agent`);
console.log(`    pay_fee for billing-agent answered ${review.paymentStatus} (403 means refused)`);
const failedChecks = review.failed.length;
console.log(`  Named checks run here: ${review.checksRun.join(", ") || "none"}`);
console.log(`  Failed rules in them: ${failedChecks}`);
process.exit(0);

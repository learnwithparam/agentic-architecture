// biome-ignore-all lint/style/useNamingConvention: the world's tools use snake_case fields.
// The Holds team's script as it runs now. It books the exam, pays the fee and waits for release.
// If the worker dies after paying, the restart starts from the top and pays again.
import { existsSync, writeFileSync } from "node:fs";

const PROVIDER_KEY = "pk-a-legacy-h0ld5";

type Hold = { shipment: string; fee_cents: number };

async function callTool<Answer>(name: string, body: object): Promise<Answer> {
  const response = await fetch(`${process.env.WORLD_URL}/tools/${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.json();
}

async function planHold(hold: Hold): Promise<void> {
  const response = await fetch(`${process.env.PROVIDER_A_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${PROVIDER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "replay-fast",
      messages: [{ role: "user", content: `TASK hold:${hold.shipment}\nPlan the hold.` }],
    }),
  });
  await response.json();
}

// The checks set CRASH_AFTER to kill the worker once, right after it pays, like a real crash.
function crashOnceIfAsked(): void {
  const marker = `${process.env.STATE_DIR}/worker-crashed`;
  if (process.env.CRASH_AFTER === "pay_exam_fee" && !existsSync(marker)) {
    writeFileSync(marker, "worker died after paying\n");
    process.exit(137);
  }
}

const { holds } = await callTool<{ holds: Hold[] }>("list_holds", {});
for (const hold of holds) {
  await planHold(hold);
  await callTool("book_exam", { shipment_id: hold.shipment });
  await callTool("pay_fee", {
    shipment_id: hold.shipment,
    purpose: "exam_fee",
    amount_cents: hold.fee_cents,
  });
  crashOnceIfAsked();
  await callTool("check_release", { shipment_id: hold.shipment });
}

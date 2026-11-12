// The Holds team's script as it runs today. It books the exam, pays the fee and waits for release.
// If the worker dies after paying, the restart starts from the top and pays again.
import { existsSync, writeFileSync } from "node:fs";
const key = "pk-a-legacy-h0ld5";
const call = async (name: string, body: object) =>
  (await fetch(`${process.env.WORLD_URL}/tools/${name}`, { method: "POST", body: JSON.stringify(body) })).json() as any;

const { holds } = await call("list_holds", {});
for (const h of holds) {
  const r = await fetch(`${process.env.PROVIDER_A_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "replay-fast", messages: [{ role: "user", content: `TASK hold:${h.shipment}\nPlan the hold.` }] }),
  });
  await r.json();
  await call("book_exam", { shipment_id: h.shipment });
  await call("pay_fee", { shipment_id: h.shipment, purpose: "exam_fee", amount_cents: h.fee_cents });
  const marker = `${process.env.STATE_DIR}/worker-crashed`;
  if (process.env.CRASH_AFTER === "pay_exam_fee" && !existsSync(marker)) {
    writeFileSync(marker, "worker died after paying\n");
    process.exit(137);
  }
  await call("check_release", { shipment_id: h.shipment });
}

// biome-ignore-all lint/style/useNamingConvention: tool fields are snake_case on the wire.
// The tools that talk to customs and move money: file an entry, handle holds, pay fees.
import {
  findShipment,
  noShipment,
  type ShipmentRow,
  type ToolCall,
  type ToolResult,
} from "./tool-helpers";

type HoldRow = { booked: number };

const LICENSED_SIGNER = `
  SELECT broker FROM signatures
  WHERE line = ?
    AND code = ? AND licence IS NOT NULL`;

// Records each line of an entry, with the licensed broker who signed its code, if any.
function recordEntryLines(call: ToolCall, entryId: number): void {
  const findSigner = call.db.query(LICENSED_SIGNER);
  const insertLine = call.db.prepare("INSERT INTO entry_lines VALUES (?,?,?,?)");
  for (const line of call.input.lines ?? []) {
    const signature = findSigner.get(line.line_id, line.code) as { broker: string } | null;
    insertLine.run(entryId, line.line_id, line.code, signature?.broker ?? null);
  }
}

function insertEntry(call: ToolCall, shipment: ShipmentRow, status: string): number {
  const insert = call.db.prepare(
    "INSERT INTO entries (shipment, filed_by, status, run_id) VALUES (?,?,?,?)",
  );
  const result = insert.run(
    shipment.id,
    call.headers.get("x-agent"),
    status,
    call.headers.get("x-run"),
  );
  return Number(result.lastInsertRowid);
}

// Customs accepts any filing. Whether a broker signed is the platform's problem, as in real life.
export function fileEntry(call: ToolCall): ToolResult {
  const shipment = findShipment(call.db, call.input.shipment_id);
  if (!shipment) return noShipment(call.input.shipment_id);
  if (shipment.status !== "open")
    return [409, { error: `${shipment.id} is already ${shipment.status}` }];
  // A shipment with an exam planned is held by customs instead of released.
  const isHeld = Boolean(shipment.exam_kind);
  const status = isHeld ? "held" : "released";
  const entryId = insertEntry(call, shipment, status);
  recordEntryLines(call, entryId);
  call.db.prepare("UPDATE shipments SET status = ? WHERE id = ?").run(status, shipment.id);
  if (!isHeld) return { entry: entryId, status, hold: null };
  call.db
    .prepare("INSERT OR IGNORE INTO holds (shipment, kind, fee_cents) VALUES (?,?,?)")
    .run(shipment.id, shipment.exam_kind, shipment.exam_fee_cents);
  const hold = { kind: shipment.exam_kind, fee_cents: shipment.exam_fee_cents };
  return { entry: entryId, status, hold };
}

const OPEN_HOLDS = `
  SELECT h.*, s.importer FROM holds h JOIN shipments s ON s.id = h.shipment
  WHERE h.released = 0 AND (?1 IS NULL OR s.importer = ?1) ORDER BY h.shipment`;

export function listHolds(call: ToolCall): ToolResult {
  const holds = call.db.query(OPEN_HOLDS).all(call.headers.get("x-importer"));
  return { holds };
}

export function bookExam(call: ToolCall): ToolResult {
  const update = call.db.prepare("UPDATE holds SET booked = 1 WHERE shipment = ?");
  const result = update.run(call.input.shipment_id);
  if (result.changes) return { booked: true };
  return [404, { error: `no hold on ${call.input.shipment_id}` }];
}

const INSERT_PAYMENT =
  "INSERT INTO payments (shipment, purpose, amount_cents, idempotency_key, paid_by) " +
  "VALUES (?,?,?,?,?)";

// Pays a fee. The same idempotency_key twice returns the first payment and moves no money.
export function payFee(call: ToolCall): ToolResult {
  const { input } = call;
  if (input.idempotency_key) {
    const earlierPayment = call.db
      .query("SELECT id FROM payments WHERE idempotency_key = ?")
      .get(input.idempotency_key) as { id: number } | null;
    if (earlierPayment) return { payment: earlierPayment.id, repeated: true };
  }
  const result = call.db
    .prepare(INSERT_PAYMENT)
    .run(
      input.shipment_id,
      input.purpose,
      input.amount_cents,
      input.idempotency_key ?? null,
      call.headers.get("x-agent"),
    );
  return { payment: Number(result.lastInsertRowid) };
}

function releaseShipment(call: ToolCall, shipmentId: string): void {
  call.db.prepare("UPDATE holds SET released = 1 WHERE shipment = ?").run(shipmentId);
  call.db.prepare("UPDATE shipments SET status = 'released' WHERE id = ?").run(shipmentId);
  call.db.prepare("UPDATE entries SET status = 'released' WHERE shipment = ?").run(shipmentId);
}

// Customs releases a held container once its exam is booked and its fee is paid.
export function checkRelease(call: ToolCall): ToolResult {
  const shipmentId = call.input.shipment_id;
  const hold = call.db
    .query("SELECT * FROM holds WHERE shipment = ?")
    .get(shipmentId) as HoldRow | null;
  if (!hold) {
    const status = findShipment(call.db, shipmentId)?.status ?? "";
    return { released: status === "released" };
  }
  const feesPaid = call.db
    .query("SELECT COUNT(*) AS n FROM payments WHERE shipment = ? AND purpose = 'exam_fee'")
    .get(shipmentId) as { n: number };
  if (hold.booked && feesPaid.n > 0) {
    releaseShipment(call, shipmentId);
    return { released: true };
  }
  return { released: false, waiting_for: hold.booked ? "exam fee" : "exam booking" };
}

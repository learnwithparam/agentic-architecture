// biome-ignore-all lint/style/useNamingConvention: tool fields are snake_case on the wire.
// What every tool shares: the shape of a call, the shape of an answer, and finding a shipment.
import type { Database } from "bun:sqlite";

// What an agent may send to a tool. Each tool reads only the fields it needs.
export type ToolInput = {
  importer?: string;
  shipment_id: string;
  line_id: string;
  code: string;
  reason?: string;
  query?: string;
  message?: string;
  lines?: { line_id: string; code: string }[];
  purpose: string;
  amount_cents: number;
  idempotency_key?: string;
};

export type ToolCall = { db: Database; input: ToolInput; headers: Headers };

// A tool answers with JSON, or with [status, JSON] when something went wrong.
export type ToolResult = object | [number, object];

export type ShipmentRow = {
  id: string;
  importer: string;
  vessel: string;
  status: string;
  exam_kind: string | null;
  exam_fee_cents: number | null;
};

export function findShipment(db: Database, id: string): ShipmentRow | null {
  return db.query("SELECT * FROM shipments WHERE id = ?").get(id) as ShipmentRow | null;
}

export function noShipment(id: string): [number, object] {
  return [404, { error: `no shipment ${id}` }];
}

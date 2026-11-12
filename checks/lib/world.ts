// The checker's view of the world: a fresh system of record per scenario, read directly.
// Checks read the ledger, the logs and the providers' bills; they never judge a model's reply.
import type { SQLQueryBindings } from "bun:sqlite";
import { join } from "node:path";
import { startWorld, type World } from "../../world/services";

export const ROOT = join(import.meta.dir, "..", "..");
export const DATA = join(ROOT, "world", "data");
export const CHECK_DB = join(ROOT, "world", "state", "check.db");

// Each scenario gets a fresh world. The database stays in world/state/check.db afterwards,
// so `bun run spend` can show what the last check saw.
export function freshWorld(): Promise<World> {
  return startWorld({ db: CHECK_DB, reset: true });
}

export function allRows<Row>(world: World, sql: string, ...values: SQLQueryBindings[]): Row[] {
  return world.db.query(sql).all(...values) as Row[];
}

export function firstRow<Row>(world: World, sql: string, ...values: SQLQueryBindings[]): Row {
  return world.db.query(sql).get(...values) as Row;
}

// Most checks ask the database for one number, such as a count or a sum, named "total".
export function numberFrom(world: World, sql: string): number {
  return firstRow<{ total: number }>(world, sql).total;
}

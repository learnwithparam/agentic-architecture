// The checker's view of the world: a fresh system of record per scenario, read directly.
// Checks read the ledger, the logs and the providers' bills; they never judge a model's reply.
import { join } from "node:path";
import { startWorld, type World } from "../../world/services";

export const ROOT = join(import.meta.dir, "..", "..");
export const DATA = join(ROOT, "world", "data");
export const CHECK_DB = join(ROOT, "world", "state", "check.db");

// Each scenario gets a fresh world. The database stays in world/state/check.db afterwards,
// so `bun run spend` can show what the last check saw.
export const freshWorld = (): Promise<World> => startWorld({ db: CHECK_DB, reset: true });

export const rows = <T = any>(w: World, sql: string, ...args: any[]) => w.db.query(sql).all(...args) as T[];
export const one = <T = any>(w: World, sql: string, ...args: any[]) => w.db.query(sql).get(...args) as T;

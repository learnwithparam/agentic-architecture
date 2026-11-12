// Runs the open queue the way Harbourgate works now: Classification, then the broker desk,
// then Paperwork, then Holds. The Holds worker is killed once, right after it pays.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { data } from "./db";
import type { World } from "./services";

export async function runAgent(file: string, env: Record<string, string>, restarts = 1) {
  for (let i = 0; i <= restarts; i++) {
    const p = Bun.spawn(["bun", file], {
      env: { ...process.env, ...env },
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await p.exited;
    if (code === 0) return;
    if (code !== 137) throw new Error(`${file} failed with exit code ${code}`);
    if (i === restarts) throw new Error(`${file} kept crashing`);
  }
}

// The broker desk: a licensed broker reviews every proposed code that is still unsigned and signs it.
export async function brokerDesk(world: World) {
  const broker = data<any[]>("brokers").find((b) => b.licensed)!;
  const rows = world.db
    .query(
      "SELECT p.line, p.code FROM proposals p LEFT JOIN signatures s ON s.line = p.line WHERE s.line IS NULL",
    )
    .all() as any[];
  for (const r of rows)
    await fetch(`${world.api}/broker/sign`, {
      method: "POST",
      body: JSON.stringify({ line_id: r.line, code: r.code, broker: broker.id }),
    });
}

export async function runBefore(world: World, stateDir: string) {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const env = { ...world.env, STATE_DIR: stateDir, CRASH_AFTER: "pay_exam_fee" };
  const dir = join(import.meta.dir, "legacy");
  await runAgent(join(dir, "classification.ts"), env);
  await brokerDesk(world);
  await runAgent(join(dir, "paperwork.ts"), env);
  await runAgent(join(dir, "holds.ts"), env);
}

// The assignment check. It runs the same rules as `bun run verify run-the-resume-on-temporal`
// on your work, and writes assignment/result.json: one pass or fail per Done-when line.
// Usage: bun run assignment [folder]   (default: the starter, which is your work)
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import rules from "../checks/run-the-resume-on-temporal";

const folder = resolve(process.argv[2] ?? join(import.meta.dir, "starter"));
const lines: Record<string, "pass" | "fail"> = {};
for (const rule of rules) {
  let holds = false;
  try {
    holds = await rule.test(folder);
  } catch {
    // A rule that crashes counts as not met.
  }
  lines[rule.says] = holds ? "pass" : "fail";
  console.log(`  ${holds ? "PASS" : "FAIL"}  ${rule.says}`);
  if (!holds) console.log(`        Try next: ${rule.tryNext}`);
}
const clientPackage = join(
  dirname(import.meta.dir),
  "node_modules/@temporalio/client/package.json",
);
const version = (await Bun.file(clientPackage).json()).version;
const result = { tool: "temporal", clientVersion: version, lines };
writeFileSync(join(import.meta.dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
const failing = Object.values(lines).filter((line) => line === "fail").length;
console.log(failing ? `${failing} line(s) fail.` : "Done. All 6 rules pass.");
process.exit(failing ? 1 : 0);

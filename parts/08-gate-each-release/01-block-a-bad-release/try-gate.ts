// biome-ignore-all lint/style/useNamingConvention: settings like RUNS_URL are in capitals.
// Try your gate on one candidate, by hand. It starts the run API, runs the [gate] command from
// platform.toml in your folder, and tells you the exit code.
//
//   bun parts/08-gate-each-release/01-block-a-bad-release/try-gate.ts glove-shortcut
//   bun parts/08-gate-each-release/01-block-a-bad-release/try-gate.ts current solution
//
// The second word picks the folder: problem (your work, the default) or solution.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startRunApi } from "./run-api";

const [candidate = "current", folderName = "problem"] = process.argv.slice(2);
const folder = join(import.meta.dir, folderName);
const platform = Bun.TOML.parse(readFileSync(join(folder, "platform.toml"), "utf8")) as {
  gate?: { command?: string };
};
const command = platform.gate?.command;
if (!command) {
  console.log(`${folderName}/platform.toml has no [gate] command. Add: command = "bun gate.ts"`);
  process.exit(1);
}

const runApi = startRunApi();
const gate = Bun.spawn(["sh", "-c", command], {
  cwd: folder,
  env: {
    ...process.env,
    CANDIDATE: candidate,
    RUNS_URL: runApi.url,
    GOLDEN_FILE: join(import.meta.dir, "golden.json"),
  },
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await gate.exited;
runApi.stop();
const meaning = exitCode === 0 ? "release" : "block";
console.log(`The gate exited with ${exitCode} (${meaning}).`);

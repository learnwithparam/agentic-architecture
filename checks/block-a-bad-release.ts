// biome-ignore-all lint/style/useNamingConvention: gate.yaml and gate.json use snake_case fields.
// The release gate blocks the planted glove prompt and names its wrong lines, releases today's
// prompt, holds the never-do rules at zero, holds the cost ceiling, judges candidates it has never
// seen through the run API only, and blocks when it cannot judge. The check runs the learner's
// [gate] command and reads its exit code and out/gate.json, never a model's reply.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type Recording,
  startRunApi,
} from "../parts/08-gate-each-release/01-block-a-bad-release/run-api";
import type { Rule } from "../scripts/verify";
import { priceOf } from "../world/providers";
import { platformToml } from "./lib/learner";
import { once } from "./lib/session";
import { ROOT } from "./lib/world";

const STEP_FOLDER = join(ROOT, "parts", "08-gate-each-release", "01-block-a-bad-release");
const GOLDEN_FILE = join(STEP_FOLDER, "golden.json");
type GoldenLine = { line_id: string; shipment_id: string; importer: string; broker_code: string };
const GOLDEN: GoldenLine[] = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")).lines;

const CANDIDATES = ["current", "glove-shortcut", "files-rush-entries", "bigger-context"];
const HIDDEN = ["hidden-good", "hidden-leaky"];

const GateReport = z.object({
  candidate: z.string(),
  run_id: z.string(),
  decision: z.enum(["release", "block"]),
  reasons: z.array(z.string()),
  pass_rate: z.number().min(0).max(1),
  pass_rate_floor: z.number(),
  lines_total: z.number().int(),
  failing_lines: z.array(z.string()),
  never_do: z.object({
    unsigned_filings: z.number(),
    cross_importer_reads: z.number(),
    double_payments: z.number(),
  }),
  cost_per_entry_micros: z.number(),
  cost_ceiling_micros: z.number(),
});
type Report = z.infer<typeof GateReport>;

type GateRun = { exitCode: number; report: Report | null; reportIsValid: boolean; printed: string };
type Outcome = { runs: Record<string, GateRun>; currentRuns: GateRun[]; apiDown: GateRun };

function recordingOf(candidate: string): Recording {
  const file = join(STEP_FOLDER, "candidates", candidate, "recorded-run.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

// Two candidates the gate has never seen: one is clean and cheap, one read another importer's
// invoice. A gate that only knows the four folder names cannot judge them.
function hiddenRecordings(): Recording[] {
  const clean = recordingOf("bigger-context");
  const cheapCalls = recordingOf("current").calls.map((call, index) => ({
    ...call,
    code: clean.calls[index].code,
  }));
  const good = { ...clean, candidate: "hidden-good", calls: cheapCalls };
  const leakyRead = {
    document_id: "HG-1051-INV",
    document_importer: "northpoint",
    for_importer: "fjordline",
  };
  const leaky = { ...good, candidate: "hidden-leaky", reads: [leakyRead] };
  return [good, leaky];
}

function readReport(folder: string): { report: Report | null; reportIsValid: boolean } {
  const file = join(folder, "out", "gate.json");
  if (!existsSync(file)) return { report: null, reportIsValid: false };
  try {
    const parsed = GateReport.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return { report: parsed.success ? parsed.data : null, reportIsValid: parsed.success };
  } catch {
    return { report: null, reportIsValid: false };
  }
}

// Run the learner's [gate] command once, the way a release pipeline would.
async function runGate(folder: string, candidate: string, runsUrl: string): Promise<GateRun> {
  const command = String(platformToml(folder).gate?.command ?? "");
  if (!command) return { exitCode: -1, report: null, reportIsValid: false, printed: "" };
  rmSync(join(folder, "out", "gate.json"), { force: true });
  const settings = { CANDIDATE: candidate, RUNS_URL: runsUrl, GOLDEN_FILE };
  const gate = Bun.spawn(["sh", "-c", command], {
    cwd: folder,
    env: { ...process.env, ...settings },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => gate.kill(9), 20000);
  const printed = await new Response(gate.stdout).text();
  const exitCode = await gate.exited;
  clearTimeout(timer);
  return { exitCode, printed, ...readReport(folder) };
}

async function scenario(folder: string): Promise<Outcome> {
  const runApi = startRunApi({ extraRecordings: hiddenRecordings() });
  try {
    const runs: Record<string, GateRun> = {};
    for (const candidate of [...CANDIDATES, ...HIDDEN]) {
      runs[candidate] = await runGate(folder, candidate, runApi.url);
    }
    const currentRuns = [runs.current];
    for (let runNumber = 2; runNumber <= 3; runNumber++) {
      currentRuns.push(await runGate(folder, "current", runApi.url));
    }
    // Nothing listens on port 9 here, so the run API is down for this run.
    const apiDown = await runGate(folder, "current", "http://127.0.0.1:9");
    return { runs, currentRuns, apiDown };
  } finally {
    runApi.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("block-a-bad-release", folder, scenario);
}

function released(gateRun: GateRun | undefined): boolean {
  return gateRun?.exitCode === 0 && gateRun.report?.decision === "release";
}

function blocked(gateRun: GateRun | undefined): boolean {
  return gateRun?.exitCode === 1 && gateRun.report?.decision === "block";
}

// The true numbers for a candidate, worked out from its recording and the golden set.
function truthFor(recording: Recording) {
  const proposed = new Map(recording.calls.map((call) => [call.line_id, call.code]));
  const wrong = GOLDEN.filter((line) => proposed.get(line.line_id) !== line.broker_code);
  const prices = recording.calls.map((call) =>
    priceOf("a", "smart", call.tokens_in, call.tokens_out),
  );
  const spend = prices.reduce((total, price) => total + price, 0);
  const entries = new Set(GOLDEN.map((line) => line.shipment_id)).size;
  return {
    failingLines: wrong.map((line) => line.line_id).sort(),
    passRate: (GOLDEN.length - wrong.length) / GOLDEN.length,
    costPerEntry: spend / entries,
  };
}

function numbersMatch(candidate: string, report: Report | null): boolean {
  if (!report) return false;
  const recording = HIDDEN.includes(candidate)
    ? hiddenRecordings().find((item) => item.candidate === candidate)
    : recordingOf(candidate);
  if (!recording) return false;
  const truth = truthFor(recording);
  const sameLines = [...report.failing_lines].sort().join() === truth.failingLines.join();
  const samePassRate = Math.abs(report.pass_rate - truth.passRate) < 0.001;
  const sameCost = Math.abs(report.cost_per_entry_micros - truth.costPerEntry) <= 1;
  return sameLines && samePassRate && sameCost;
}

function readRules(folder: string): Record<string, unknown> {
  const file = join(folder, "gate.yaml");
  if (!existsSync(file)) return {};
  return (Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
}

const NEVER_DO = ["unsigned_filings", "cross_importer_reads", "double_payments"];

export default [
  {
    says: "gate.yaml allows zero unsigned filings, cross-importer reads and double payments",
    test: (folder) => {
      const neverDo = (readRules(folder).never_do ?? {}) as Record<string, unknown>;
      return NEVER_DO.every((metric) => neverDo[metric] === 0);
    },
    tryNext: "under never_do: set unsigned_filings, cross_importer_reads and double_payments to 0",
  },
  {
    says: "gate.yaml sets a pass-rate floor below 100% and a cost ceiling per entry",
    test: (folder) => {
      const rules = readRules(folder);
      const floor = Number(rules.pass_rate_floor);
      const ceiling = Number(rules.max_cost_per_entry_micros);
      return floor > 0 && floor < 1 && ceiling > 0;
    },
    tryNext: "set pass_rate_floor between 0 and 1 (for example 0.95) and max_cost_per_entry_micros",
  },
  {
    says: "today's prompt is released (exit 0) in 3 fresh runs",
    test: async (folder) => (await run(folder)).currentRuns.every(released),
    tryNext: "the current prompt gets 39 of 40 lines right; lower a floor that demands perfection",
  },
  {
    says: "the planted glove prompt is blocked (exit 1)",
    test: async (folder) => blocked((await run(folder)).runs["glove-shortcut"]),
    tryNext: "compare each proposed code with broker_code and block when the pass rate is too low",
  },
  {
    says: "the block names every glove line the prompt got wrong, HG-1051-L1 among them",
    test: async (folder) => {
      const gloveRun = (await run(folder)).runs["glove-shortcut"];
      const lines = gloveRun?.report?.failing_lines ?? [];
      return lines.includes("HG-1051-L1") && numbersMatch("glove-shortcut", gloveRun.report);
    },
    tryNext: "put the id of every wrong golden line in failing_lines, and print them",
  },
  {
    says: "a candidate with every line right but one unsigned filing is blocked",
    test: async (folder) => blocked((await run(folder)).runs["files-rush-entries"]),
    tryNext: "block when any never_do count from the run API is above what gate.yaml allows",
  },
  {
    says: "a candidate above the cost ceiling is blocked, even with every line right",
    test: async (folder) => blocked((await run(folder)).runs["bigger-context"]),
    tryNext: "divide spend_micros by entries and block above max_cost_per_entry_micros",
  },
  {
    says: "candidates the gate has never seen are judged through the run API alone",
    test: async (folder) => {
      const { runs } = await run(folder);
      return released(runs["hidden-good"]) && blocked(runs["hidden-leaky"]);
    },
    tryNext: "read every number from GET /runs/<run_id>; never from the candidates folder",
  },
  {
    says: "with the run API down, the gate blocks instead of releasing",
    test: async (folder) => {
      const { apiDown } = await run(folder);
      return apiDown.exitCode > 0 && apiDown.report?.decision !== "release";
    },
    tryNext: "when the gate cannot reach RUNS_URL, print why and exit 2; never exit 0",
  },
  {
    says: "out/gate.json matches its schema, and its numbers match each run",
    test: async (folder) => {
      const { runs } = await run(folder);
      return [...CANDIDATES, ...HIDDEN].every(
        (candidate) =>
          runs[candidate]?.reportIsValid && numbersMatch(candidate, runs[candidate].report),
      );
    },
    tryNext: "write every field the README lists to out/gate.json, with pass_rate from 0 to 1",
  },
] satisfies Rule[];

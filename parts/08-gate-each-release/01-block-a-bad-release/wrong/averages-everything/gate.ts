// biome-ignore-all lint/style/useNamingConvention: the run API and gate.json use snake_case fields.
// The release gate. It asks the run API to run one candidate on the golden set, grades every line
// against the broker's code, and compares the run with the rules in gate.yaml.
// Exit 0 means release. Exit 1 means block. Exit 2 means it could not judge, so it blocks too.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

type NeverDo = { unsigned_filings: number; cross_importer_reads: number; double_payments: number };
type Rules = { never_do: NeverDo; pass_rate_floor: number; max_cost_per_entry_micros: number };
type ProposedLine = { line_id: string; importer: string; proposed_code: string };
type Run = {
  run_id: string;
  lines: ProposedLine[];
  entries: number;
  spend_micros: number;
  never_do: NeverDo;
};
type GoldenLine = { line_id: string; broker_code: string };

const settings = process.env;
const candidate = settings.CANDIDATE ?? "current";
const runsUrl = settings.RUNS_URL ?? "http://127.0.0.1:4300";
const goldenFile = settings.GOLDEN_FILE ?? "../golden.json";

function readRules(): Rules {
  return Bun.YAML.parse(readFileSync("gate.yaml", "utf8")) as Rules;
}

function readGoldenSet(): GoldenLine[] {
  return JSON.parse(readFileSync(goldenFile, "utf8")).lines;
}

// Start a run of the candidate, then read its results. Both go through the run API only.
async function runCandidate(): Promise<Run> {
  const started = await fetch(`${runsUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidate }),
  });
  const startBody = await started.json();
  if (!started.ok) throw new Error(`the run API said ${started.status}: ${startBody.error}`);
  const finished = await fetch(`${runsUrl}/runs/${startBody.run_id}`);
  if (!finished.ok) throw new Error(`the run API has no results for ${startBody.run_id}`);
  return (await finished.json()) as Run;
}

// A golden line counts as wrong when the candidate proposed another code, or none at all.
function wrongLines(run: Run, golden: GoldenLine[]): string[] {
  const proposedCodes = new Map(run.lines.map((line) => [line.line_id, line.proposed_code]));
  const wrong = golden.filter((line) => proposedCodes.get(line.line_id) !== line.broker_code);
  return wrong.map((line) => line.line_id);
}

function judge(run: Run, rules: Rules, golden: GoldenLine[]) {
  const failingLines = wrongLines(run, golden);
  const passRate = (golden.length - failingLines.length) / golden.length;
  const costPerEntry = Math.round(run.spend_micros / Math.max(1, run.entries));
  // One score is enough: if the codes are right and the cost is fine, ship it.
  const reasons: string[] = [];
  if (passRate < rules.pass_rate_floor) {
    const percent = (passRate * 100).toFixed(1);
    reasons.push(
      `pass rate ${percent}% is below the floor; wrong lines: ${failingLines.join(", ")}`,
    );
  }
  if (costPerEntry > rules.max_cost_per_entry_micros) {
    reasons.push(`cost per entry ${costPerEntry} micro-dollars is above the ceiling`);
  }
  return {
    candidate,
    run_id: run.run_id,
    decision: reasons.length === 0 ? "release" : "block",
    reasons,
    pass_rate: passRate,
    pass_rate_floor: rules.pass_rate_floor,
    lines_total: golden.length,
    failing_lines: failingLines,
    never_do: run.never_do,
    cost_per_entry_micros: costPerEntry,
    cost_ceiling_micros: rules.max_cost_per_entry_micros,
  };
}

function writeReport(report: object): void {
  mkdirSync("out", { recursive: true });
  writeFileSync("out/gate.json", `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<number> {
  const rules = readRules();
  const report = judge(await runCandidate(), rules, readGoldenSet());
  writeReport(report);
  console.log(`Gate for ${candidate} (${report.run_id}):`);
  console.log(`  pass rate ${(report.pass_rate * 100).toFixed(1)}% of ${report.lines_total} lines`);
  console.log(`  cost per entry ${report.cost_per_entry_micros} micro-dollars`);
  for (const reason of report.reasons) console.log(`  FAIL  ${reason}`);
  if (report.decision === "release") {
    console.log(`Released: ${candidate} meets every rule in gate.yaml.`);
    return 0;
  }
  console.log(`Blocked: ${candidate} broke ${report.reasons.length} rule(s). Do not release it.`);
  return 1;
}

// When the gate cannot judge, it blocks. A gate that releases on an error is no gate.
try {
  process.exit(await main());
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  writeReport({ candidate, decision: "block", reasons: [`could not judge: ${reason}`] });
  console.log(`Blocked: the gate could not judge ${candidate}: ${reason}`);
  process.exit(2);
}

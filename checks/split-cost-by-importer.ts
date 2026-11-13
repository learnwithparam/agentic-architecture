// biome-ignore-all lint/style/useNamingConvention: the cost report and the ledger use snake_case.
// Cost per released entry, for each importer, that adds up to the providers' bill.
// The check runs the open queue on the finished platform, plants last month's untagged rows,
// runs your nightly job, then runs your cost report and compares it with the system of record.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startPlatform } from "../reference/platform";
import type { Rule } from "../scripts/verify";
import { brokerDesk } from "../world/scenario";
import type { World } from "../world/services";
import { keyOf, TEAMS } from "./lib/gateway";
import { platformToml } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, CHECK_DB, freshWorld, numberFrom, ROOT } from "./lib/world";

const IMPORTERS = ["fjordline", "northpoint", "ridgeway"];
const NIGHTLY_RUN = "nightly-tariff-notes";
// Last month the nightly job ran before the gateway asked for an importer. Its rows have none.
const LAST_MONTH_COSTS = [1200, 800, 450];
const RUN_TIMEOUT_MS = 10000;

type ImporterCost = {
  importer?: string;
  spend_micros?: number;
  released?: number;
  cost_per_entry_micros?: number | null;
};
type CostReport = {
  importers?: ImporterCost[];
  unattributed_micros?: number;
  total_micros?: number;
  billed_micros?: number;
};

async function runCommand(command: string, folder: string, settings: Record<string, string>) {
  const child = Bun.spawn(["sh", "-c", `exec ${command}`], {
    cwd: folder,
    env: { ...process.env, ...settings },
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(9), RUN_TIMEOUT_MS);
  const printed = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  clearTimeout(timer);
  return { exitCode, printed };
}

// The open queue on the finished platform, so there are released entries and real spend.
async function runOpenQueue(world: World, platformSettings: Record<string, string>) {
  const stateFolder = join(ROOT, "world", "state", "cost-drill");
  rmSync(stateFolder, { recursive: true, force: true });
  mkdirSync(stateFolder, { recursive: true });
  for (const name of ["classification", "paperwork", "holds"]) {
    const team = TEAMS.find((candidate) => candidate.team === name);
    const settings = {
      ...platformSettings,
      AGENT: String(team?.agent),
      TEAM_KEY: keyOf(name),
      RUN_ID: `${name}-run-1`,
      STATE_DIR: stateFolder,
    };
    await runCommand(`bun ${join(ROOT, "teams", `${name}.ts`)}`, ROOT, settings);
    if (name === "classification") await brokerDesk(world);
  }
}

function plantLastMonth(world: World): void {
  const spendRow = world.db.prepare(
    "INSERT INTO spend_log (request_id, team, importer, role, provider, tokens_in, tokens_out, " +
      "cost_micros, status, run_id) VALUES (?, 'platform', NULL, 'fast', 'b', 0, 0, ?, 'ok', ?)",
  );
  const billRow = world.db.prepare(
    "INSERT INTO provider_calls (provider, key_owner, role, tokens_in, tokens_out, cost_micros, " +
      "status) VALUES ('b', 'platform', 'fast', 0, 0, ?, 200)",
  );
  for (const [index, cost] of LAST_MONTH_COSTS.entries()) {
    spendRow.run(`nightly-old-${index + 1}`, cost, "nightly-last-month");
    billRow.run(cost);
  }
}

type Truth = {
  spendByImporter: Record<string, number>;
  releasedByImporter: Record<string, number>;
  billed: number;
  nightlyRowsByImporter: Record<string, number>;
};

function countsByImporter(world: World, sql: string, ...values: string[]): Record<string, number> {
  const rows = allRows<{ importer: string; total: number }>(world, sql, ...values);
  return Object.fromEntries(rows.map((row) => [row.importer, row.total]));
}

function readTruth(world: World): Truth {
  return {
    spendByImporter: countsByImporter(
      world,
      "SELECT importer, SUM(cost_micros) AS total FROM spend_log GROUP BY importer",
    ),
    releasedByImporter: countsByImporter(
      world,
      "SELECT s.importer, COUNT(*) AS total FROM entries e JOIN shipments s ON s.id = e.shipment " +
        "WHERE e.status = 'released' GROUP BY s.importer",
    ),
    billed: numberFrom(world, "SELECT COALESCE(SUM(cost_micros),0) AS total FROM provider_calls"),
    nightlyRowsByImporter: countsByImporter(
      world,
      "SELECT importer, COUNT(*) AS total FROM spend_log WHERE run_id = ? GROUP BY importer",
      NIGHTLY_RUN,
    ),
  };
}

type Outcome = { error?: string; report: CostReport | null; truth: Truth };

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  const platform = await startPlatform(world, join(ROOT, "world", "state", "cost-platform.db"));
  try {
    const platformSettings = { ...world.env, ...platform.env };
    await runOpenQueue(world, platformSettings);
    plantLastMonth(world);
    const commands = platformToml(folder);
    const nightlySettings = { ...platformSettings, TEAM_KEY: keyOf("classification") };
    const nightly = String(commands.nightly?.run ?? "false");
    await runCommand(nightly, folder, { ...nightlySettings, RUN_ID: NIGHTLY_RUN });
    await Bun.sleep(100);
    const costCommand = `${String(commands.costs?.run ?? "false")} --json`;
    const costs = await runCommand(costCommand, folder, { WORLD_DB: CHECK_DB });
    const printedLines = costs.printed.trim().split("\n");
    const report = JSON.parse(printedLines.at(-1) || "null");
    return { report, truth: readTruth(world) };
  } finally {
    await platform.stop();
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("split-cost-by-importer", folder, scenario);
}

function rowFor(outcome: Outcome, importer: string): ImporterCost | undefined {
  return outcome.report?.importers?.find((row) => row.importer === importer);
}

function spendAndReleasedMatch(outcome: Outcome): boolean {
  return IMPORTERS.every((importer) => {
    const row = rowFor(outcome, importer);
    const spendMatches = row?.spend_micros === (outcome.truth.spendByImporter[importer] ?? 0);
    const released = outcome.truth.releasedByImporter[importer] ?? 0;
    return spendMatches && row?.released === released;
  });
}

function costPerEntryRight(outcome: Outcome): boolean {
  return IMPORTERS.every((importer) => {
    const row = rowFor(outcome, importer);
    const released = outcome.truth.releasedByImporter[importer] ?? 0;
    if (released === 0) return row?.cost_per_entry_micros === null;
    const expected = Math.round((outcome.truth.spendByImporter[importer] ?? 0) / released);
    return row?.cost_per_entry_micros === expected;
  });
}

function addsUpToTheBill(outcome: Outcome): boolean {
  const report = outcome.report;
  const rows = report?.importers ?? [];
  const importerTotal = rows.reduce((sum, row) => sum + Number(row.spend_micros ?? 0), 0);
  const total = importerTotal + Number(report?.unattributed_micros ?? 0);
  const billed = outcome.truth.billed;
  return billed > 0 && total === billed && report?.total_micros === billed;
}

const lastMonthTotal = LAST_MONTH_COSTS.reduce((sum, cost) => sum + cost, 0);

export default [
  {
    says: "bun costs.ts --json prints a row for each of the 3 importers",
    test: async (folder) => {
      const outcome = await run(folder);
      return IMPORTERS.every((importer) => rowFor(outcome, importer));
    },
    tryNext: "run WORLD_DB=../../../../world/state/check.db bun costs.ts --json and read the error",
  },
  {
    says: "each importer's spend and released entries match the system of record",
    test: async (folder) => spendAndReleasedMatch(await run(folder)),
    tryNext: "sum spend_log by importer, and count entries with status released by importer",
  },
  {
    says: "cost per released entry is that importer's spend divided by its released entries",
    test: async (folder) => costPerEntryRight(await run(folder)),
    tryNext: "divide by released entries only, and round to whole micro-dollars",
  },
  {
    says: `last month's untagged rows show as unattributed (${lastMonthTotal} micro-dollars)`,
    test: async (folder) => (await run(folder)).report?.unattributed_micros === lastMonthTotal,
    tryNext: "sum the spend_log rows whose importer IS NULL into unattributed_micros",
  },
  {
    says: "importers plus unattributed add up to the providers' bill, to the micro-dollar",
    test: async (folder) => addsUpToTheBill(await run(folder)),
    tryNext: "add unattributed to the total, and read billed_micros from provider_calls",
  },
  {
    says: "the nightly job bills each importer for its own notes: one call each",
    test: async (folder) => {
      const rows = (await run(folder)).truth?.nightlyRowsByImporter ?? {};
      return IMPORTERS.every((importer) => rows[importer] === 1);
    },
    tryNext: "in nightly.ts, send x-importer for the importer whose notes the call refreshes",
  },
] satisfies Rule[];

// Onboard a new team with one command. It changes data only: the team list, the policy and the
// budgets. No platform code changes, so every team joins the same way.
//
//   bun onboard.ts billing list_open_shipments,read_shipment,email_importer 500000
//
// It reads and writes TEAMS_FILE, POLICY_FILE and BUDGETS_FILE (by default, the files here).
// Running it twice for the same team changes nothing the second time.
import { readFileSync, writeFileSync } from "node:fs";

type Team = { team: string; agent: string; does?: string; key: string };

const settings = process.env;
const teamsFile = settings.TEAMS_FILE ?? "teams.json";
const policyFile = settings.POLICY_FILE ?? "policy.json";
const budgetsFile = settings.BUDGETS_FILE ?? "budgets.json";

function readJson<Shape>(path: string): Shape {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// A fresh secret key for the team, never a copy of another team's key.
function newTeamKey(team: string): string {
  const randomPart = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
  return `hgk_${team}_${randomPart}`;
}

const [team, toolList, budgetText] = process.argv.slice(2);
if (!team || !toolList || !budgetText) {
  console.log("Usage: bun onboard.ts <team> <tool,tool,...> <budget in micro-dollars>");
  process.exit(1);
}
const agent = `${team}-agent`;

const teams = readJson<Team[]>(teamsFile);
const existing = teams.find((candidate) => candidate.team === team);
if (!existing) {
  teams.push({ team, agent, does: `the ${team} team's agent`, key: newTeamKey(team) });
  writeJson(teamsFile, teams);
}

// TODO: finish onboarding by changing data only, never platform code:
//   1. in the policy file, set "<team>-agent" to the tools in toolList (split on commas),
//   2. in the budgets file, set teams.<team> to the budget, as a number.
// Use readJson and writeJson with policyFile and budgetsFile.
console.log(`TODO: give ${agent} the tools ${toolList} in ${policyFile}.`);
console.log(`TODO: give ${team} a budget of ${budgetText} in ${budgetsFile}.`);

if (existing) {
  console.log(`Team ${team} was already on the platform. Its tools and budget are up to date.`);
} else {
  console.log(`Team ${team} is onboarded. Agent: ${agent}. Tools: ${toolList}.`);
  console.log("Give the team its key from the team list, in a safe way.");
}

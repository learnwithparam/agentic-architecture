// biome-ignore-all lint/style/useNamingConvention: the tools use snake_case fields.
// An "ask" decision holds file_entry until a licensed broker signed the exact code on every
// line. A trainee's signature never counts. The check plays the agents and the brokers,
// and reads what customs recorded.
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, DATA, freshWorld, numberFrom } from "./lib/world";
import {
  callGateway,
  startToolServers,
  type ToolServers,
  toolGatewayEnv,
} from "./register-approved-tools";

type Broker = { id: string; licensed: boolean };

const LICENSED_BROKERS: string[] = (require(`${DATA}/brokers.json`) as Broker[])
  .filter((broker) => broker.licensed)
  .map((broker) => broker.id);

// HG-1052 is a Fjordline shipment with no exam planned, so customs releases it once filed.
const SHIPMENT = "HG-1052";
const LINES = [
  { line_id: "HG-1052-L1", code: "ST-6201-40" },
  { line_id: "HG-1052-L2", code: "ST-6306-22" },
  { line_id: "HG-1052-L3", code: "ST-6306-22" },
];
const AS_PAPERWORK = { team: "paperwork", importer: "fjordline" };

type Answer = { status: number; error: string };
type FiledLine = { line: string; code: string };

type Outcome = {
  up?: boolean;
  unsigned: Answer;
  entriesAfterUnsigned: number;
  traineeSigned: Answer;
  entriesAfterTrainee: number;
  allSigned: Answer;
  shipmentStatus: string;
  linesWithoutLicensedSigner: number;
  askAuditLines: number;
};

async function proposeEveryLine(gatewayUrl: string): Promise<void> {
  for (const line of LINES) {
    const input = { ...line, reason: "matches the invoice description" };
    const asClassification = { team: "classification", importer: "fjordline" };
    await callGateway(gatewayUrl, { ...asClassification, tool: "propose_code", input });
  }
}

async function fileTheEntry(gatewayUrl: string): Promise<Answer> {
  const input = { shipment_id: SHIPMENT, lines: LINES };
  const answer = await callGateway(gatewayUrl, { ...AS_PAPERWORK, tool: "file_entry", input });
  return { status: answer.status, error: answer.body.error ?? "" };
}

// A licensed broker signs through the world's approval card.
async function brokerSigns(world: World, broker: string, line: (typeof LINES)[number]) {
  const signing = { broker, line_id: line.line_id, code: line.code };
  const request = { method: "POST", body: JSON.stringify(signing) };
  await fetch(`${world.api}/broker/sign`, request);
}

// An old system copied in a signature from Jo Whitfield, a trainee, with a made-up licence.
function plantTraineeSignature(world: World, line: (typeof LINES)[number]): void {
  const insert = world.db.prepare("INSERT INTO signatures VALUES (?,?,?,?)");
  insert.run(line.line_id, line.code, "jo-whitfield", "SB-90001");
}

const entriesFor = (world: World) =>
  numberFrom(world, `SELECT COUNT(*) AS total FROM entries WHERE shipment = '${SHIPMENT}'`);

function linesWithoutLicensedSigner(world: World): number {
  const filed = allRows<FiledLine>(world, "SELECT line, code FROM entry_lines");
  const signatures = allRows<FiledLine & { broker: string }>(world, "SELECT * FROM signatures");
  const hasLicensedSigner = (line: FiledLine) =>
    signatures.some(
      (signature) =>
        signature.line === line.line &&
        signature.code === line.code &&
        LICENSED_BROKERS.includes(signature.broker),
    );
  return filed.filter((line) => !hasLicensedSigner(line)).length;
}

function readCustoms(world: World) {
  const shipment = world.db.query("SELECT status FROM shipments WHERE id = ?").get(SHIPMENT) as {
    status: string;
  };
  const askLines = "SELECT COUNT(*) AS total FROM spans WHERE name = 'file_entry'";
  return {
    shipmentStatus: shipment.status,
    linesWithoutLicensedSigner: linesWithoutLicensedSigner(world),
    askAuditLines: numberFrom(world, `${askLines} AND detail LIKE '%ask%'`),
  };
}

async function signAndFile(world: World, gatewayUrl: string) {
  await proposeEveryLine(gatewayUrl);
  const unsigned = await fileTheEntry(gatewayUrl);
  const entriesAfterUnsigned = entriesFor(world);
  // Signatures arrive later, so count unsigned filed lines after each filing, not only at the end.
  const unsignedEarly = linesWithoutLicensedSigner(world);
  await brokerSigns(world, "amara-okafor", LINES[0]);
  await brokerSigns(world, "amara-okafor", LINES[1]);
  plantTraineeSignature(world, LINES[2]);
  const traineeSigned = await fileTheEntry(gatewayUrl);
  const entriesAfterTrainee = entriesFor(world);
  const unsignedWithTrainee = linesWithoutLicensedSigner(world);
  await brokerSigns(world, "tomas-reyes", LINES[2]);
  const allSigned = await fileTheEntry(gatewayUrl);
  await Bun.sleep(100);
  const filings = { unsigned, entriesAfterUnsigned, traineeSigned, entriesAfterTrainee };
  const customs = readCustoms(world);
  const worstCount = Math.max(
    unsignedEarly,
    unsignedWithTrainee,
    customs.linesWithoutLicensedSigner,
  );
  return { ...filings, allSigned, ...customs, linesWithoutLicensedSigner: worstCount };
}

async function withServices(folder: string, world: World, servers: ToolServers) {
  const policy = await startLearner(folder, "policy", world.env);
  try {
    const settings = { ...toolGatewayEnv(world.env, servers), POLICY_URL: policy.url };
    const gateway = await startLearner(folder, "tools", settings);
    try {
      return { up: true, ...(await signAndFile(world, gateway.url)) };
    } finally {
      await gateway.stop();
    }
  } finally {
    await policy.stop();
  }
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  const servers = startToolServers(world.api, false);
  try {
    return await withServices(folder, world, servers);
  } finally {
    servers.stop();
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("require-broker-signoff", folder, scenario);
}

const waits = (answer: Answer | undefined) =>
  answer?.status === 403 && answer.error.startsWith("ask:");

export default [
  {
    says: "your policy engine and tool gateway start from platform.toml",
    test: async (folder) => (await run(folder)).up === true,
    tryNext: "run bun policy.ts and bun tool-gateway.ts in your folder and fix any error",
  },
  {
    says: "file_entry with unsigned lines waits: 403 with a reason that starts ask:",
    test: async (folder) => {
      const outcome = await run(folder);
      return waits(outcome.unsigned) && outcome.entriesAfterUnsigned === 0;
    },
    tryNext: 'keep file_entry under "ask" and refuse it while any line has no licensed signature',
  },
  {
    says: "a line signed only by the trainee Jo Whitfield does not count",
    test: async (folder) => {
      const outcome = await run(folder);
      return waits(outcome.traineeSigned) && outcome.entriesAfterTrainee === 0;
    },
    tryNext: "count a signature only when its broker is licensed in BROKERS_FILE",
  },
  {
    says: "with licensed signatures on every line, the filing goes through and customs releases it",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.allSigned?.status === 200 && outcome.shipmentStatus === "released";
    },
    tryNext: "read the proposals with read_proposals and allow the filing when every line matches",
  },
  {
    says: "customs shows 0 filed lines without a licensed broker's signature",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.up === true && outcome.linesWithoutLicensedSigner === 0;
    },
    tryNext: "compare the code on each line too: a broker signs one exact code, not the line",
  },
  {
    says: "the audit log shows the filing waiting for a broker",
    test: async (folder) => ((await run(folder)).askAuditLines ?? 0) >= 1,
    tryNext: "write the audit line after you resolve the ask, with the ask: reason in it",
  },
] satisfies Rule[];

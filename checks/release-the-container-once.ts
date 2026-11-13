// biome-ignore-all lint/style/useNamingConvention: settings like PAGER_URL are in capitals.
// Money moves once, even when a whole run is replayed with an empty journal. And a container
// customs never releases gets one page to a broker, after a wait with a limit.
// The check runs your worker three times: a first run, a restart with the same journal, and a
// replay with an empty journal. It reads the payments and the pages, never a model's reply.
import { rmSync } from "node:fs";
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { once } from "./lib/session";
import { allRows, freshWorld, numberFrom } from "./lib/world";
import {
  freshStateFolder,
  HELD_CONTAINERS,
  putHolds,
  runWorker,
  workerSettings,
} from "./resume-a-killed-run";

const RUN_ID = "holds-replay-drill";
const RELEASED = HELD_CONTAINERS[0].shipment;
// Customs never releases this one in this check: its officer is away.
const STUCK = HELD_CONTAINERS[1].shipment;
const RELEASE_CHECKS = 5;

type Page = { shipment?: string; reason?: string };

// A stand-in for the world's tools that answers check_release for the stuck container itself.
// Every other call goes on to the real world.
function startSlowCustoms(worldUrl: string) {
  const releaseChecks = { stuck: 0 };
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = await request.text();
    const isReleaseCheck = url.pathname === "/tools/check_release";
    if (isReleaseCheck && body.includes(STUCK)) {
      releaseChecks.stuck++;
      return Response.json({ released: false, waiting_for: "a customs officer" });
    }
    const forwarded = { method: request.method, headers: request.headers, body: body || undefined };
    return fetch(`${worldUrl}${url.pathname}${url.search}`, forwarded);
  };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  return { url: `http://127.0.0.1:${server.port}`, releaseChecks, stop: () => server.stop(true) };
}

function startPager() {
  const pages: Page[] = [];
  const handle = async (request: Request): Promise<Response> => {
    if (request.method === "POST") pages.push(await request.json().catch(() => ({})));
    return Response.json({ paged: true });
  };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  return { url: `http://127.0.0.1:${server.port}`, pages, stop: () => server.stop(true) };
}

type Outcome = {
  error?: string;
  exits: (number | null)[];
  releasedAfterFirstRun: boolean;
  paymentsAfterFirstRun: number;
  paymentsAfterReplay: number;
  payCallsBeforeReplay: number;
  payCallsAfterReplay: number;
  keys: string[];
  stuckReleaseChecks: number;
  pagesAfterRestart: Page[];
};

const countPayments = (world: World) =>
  numberFrom(world, "SELECT COUNT(*) AS total FROM payments WHERE purpose = 'exam_fee'");
const countPayCalls = (world: World) =>
  numberFrom(world, "SELECT COUNT(*) AS total FROM tool_audit WHERE tool = 'pay_fee'");

function wasReleased(world: World): boolean {
  const sql = `SELECT COUNT(*) AS total FROM holds WHERE shipment = '${RELEASED}' AND released = 1`;
  return numberFrom(world, sql) === 1;
}

type Drill = { folder: string; world: World; settings: Record<string, string> };

// First run, then a restart with the same journal, then a replay with an empty journal.
async function runThreeTimes(drill: Drill, pager: ReturnType<typeof startPager>) {
  const { folder, world, settings } = drill;
  const exits: (number | null)[] = [];
  exits.push((await runWorker(folder, settings)).exitCode);
  const releasedAfterFirstRun = wasReleased(world);
  const paymentsAfterFirstRun = countPayments(world);
  exits.push((await runWorker(folder, settings)).exitCode);
  const pagesAfterRestart = [...pager.pages];
  const payCallsBeforeReplay = countPayCalls(world);
  rmSync(settings.JOURNAL_DB, { force: true });
  exits.push((await runWorker(folder, settings)).exitCode);
  return {
    exits,
    releasedAfterFirstRun,
    paymentsAfterFirstRun,
    pagesAfterRestart,
    payCallsBeforeReplay,
  };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  putHolds(world);
  const customs = startSlowCustoms(world.api);
  const pager = startPager();
  const stateFolder = freshStateFolder("replay-drill");
  const slowWorld = { ...world, env: { ...world.env, WORLD_URL: customs.url } };
  const { platform, settings } = await workerSettings(slowWorld, stateFolder, RUN_ID);
  try {
    const drillSettings = {
      ...settings,
      PAGER_URL: pager.url,
      RELEASE_CHECKS: String(RELEASE_CHECKS),
      RELEASE_PAUSE_MS: "20",
    };
    const runs = await runThreeTimes({ folder, world, settings: drillSettings }, pager);
    const keyRows = allRows<{ idempotency_key: string | null }>(
      world,
      "SELECT idempotency_key FROM payments",
    );
    return {
      ...runs,
      paymentsAfterReplay: countPayments(world),
      payCallsAfterReplay: countPayCalls(world),
      keys: keyRows.map((row) => String(row.idempotency_key ?? "")),
      stuckReleaseChecks: customs.releaseChecks.stuck,
    };
  } finally {
    await platform.stop();
    customs.stop();
    pager.stop();
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("release-the-container-once", folder, scenario);
}

function pagedOnceWithReason(outcome: Outcome): boolean {
  const pages = outcome.pagesAfterRestart ?? [];
  if (pages.length !== 1) return false;
  const reason = String(pages[0].reason ?? "").toLowerCase();
  return pages[0].shipment === STUCK && reason.includes("demurrage");
}

export default [
  {
    says: "the worker finishes every time, even while one container is never released",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.exits?.length === 3 && outcome.exits.every((exitCode) => exitCode === 0);
    },
    tryNext: "give the wait for release a limit: ask RELEASE_CHECKS times, then go on",
  },
  {
    says: `${RELEASED} is released, and each container's fee is paid once`,
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.releasedAfterFirstRun && outcome.paymentsAfterFirstRun === 2;
    },
    tryNext: "keep the steps from the last step: plan, book, pay, then wait for release",
  },
  {
    says: "the replay with an empty journal really tried to pay again, so the test is real",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.payCallsAfterReplay > outcome.payCallsBeforeReplay;
    },
    tryNext: "read the journal only from JOURNAL_DB, so an empty journal means a fresh start",
  },
  {
    says: "a replay of the whole run moves no money",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.paymentsAfterReplay === outcome.paymentsAfterFirstRun;
    },
    tryNext: "build the idempotency key from RUN_ID, the purpose and the shipment, never at random",
  },
  {
    says: "every payment's idempotency key names its run",
    test: async (folder) => {
      const keys = (await run(folder)).keys ?? [];
      return keys.length > 0 && keys.every((key) => key.includes(RUN_ID));
    },
    tryNext:
      "join RUN_ID, the purpose and the shipment into the key, such as run-1:exam_fee:HG-1057",
  },
  {
    says: `${STUCK} was checked ${RELEASE_CHECKS} times, then a broker got one demurrage page`,
    test: async (folder) => {
      const outcome = await run(folder);
      const checkedEnough = outcome.stuckReleaseChecks >= RELEASE_CHECKS;
      return checkedEnough && pagedOnceWithReason(outcome);
    },
    tryNext: "after the last check, POST { shipment, run_id, reason } to PAGER_URL, as a step",
  },
] satisfies Rule[];

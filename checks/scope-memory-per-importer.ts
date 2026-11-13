// Agent memory is filtered by importer before it is ranked, and a superseded ruling is never
// a candidate. The check plants notes whose meaning sits very close to Ridgeway's question but
// belong to Fjordline, then calls the learner's recall() and remember() as each importer.
import type { PGlite } from "@electric-sql/pglite";
import type { Rule } from "../scripts/verify";
import { actAs, openPlatformDb, unforcedTables } from "./isolate-importer-data";
import { once } from "./lib/session";

type PlantedNote = {
  id: string;
  importer: string;
  kind: string;
  note: string;
  embedding: number[];
  supersededBy?: string;
};

// Eight numbers stand for a note's meaning. The question is [1, 0, 0, 0, 0, 0, 0, 0].
const meaning = (first: number, second: number, last = 0) => [first, second, 0, 0, 0, 0, 0, last];
const QUESTION = meaning(1, 0);
const NEW_NOTE_MEANING = meaning(0, 0, 1);

const PLANTED: PlantedNote[] = [
  {
    id: "mem-f1",
    importer: "fjordline",
    kind: "ruling",
    note: "Tents of nylon: ST-6306-22",
    embedding: meaning(1, 0.05),
  },
  {
    id: "mem-f2",
    importer: "fjordline",
    kind: "ruling",
    note: "Anoraks: ST-6201-40",
    embedding: meaning(1, 0.1),
  },
  {
    id: "mem-f3",
    importer: "fjordline",
    kind: "broker_note",
    note: "Fjordline pays on 30 days",
    embedding: meaning(1, 0.15),
  },
  {
    id: "mem-r0",
    importer: "ridgeway",
    kind: "ruling",
    note: "Decaf beans: ST-0901-11",
    embedding: meaning(1, 0.25),
    supersededBy: "mem-r1",
  },
  {
    id: "mem-r1",
    importer: "ridgeway",
    kind: "ruling",
    note: "Decaf beans: ST-0901-12",
    embedding: meaning(1, 0.6),
  },
  {
    id: "mem-r2",
    importer: "ridgeway",
    kind: "broker_note",
    note: "Ridgeway lots come in bursts",
    embedding: meaning(1, 0.8),
  },
  {
    id: "mem-r3",
    importer: "ridgeway",
    kind: "ruling",
    note: "Green beans: ST-0901-11",
    embedding: meaning(1, 1),
  },
  {
    id: "mem-r4",
    importer: "ridgeway",
    kind: "broker_note",
    note: "Ask for the phyto paper",
    embedding: meaning(0, 1),
  },
  {
    id: "mem-n1",
    importer: "northpoint",
    kind: "ruling",
    note: "Medical gloves: ST-4015-12",
    embedding: meaning(1, 0.3),
  },
];
const RIDGEWAY_BEST_THREE = ["mem-r1", "mem-r2", "mem-r3"];

const asVector = (numbers: number[]) => `[${numbers.join(",")}]`;

async function plantNotes(database: PGlite): Promise<void> {
  for (const planted of PLANTED) {
    await actAs(database, planted.importer);
    const values = [
      planted.id,
      planted.importer,
      planted.kind,
      planted.note,
      asVector(planted.embedding),
      planted.supersededBy ?? null,
    ];
    await database.query(
      "INSERT INTO memory (id, importer_id, kind, note, embedding, superseded_by) " +
        "VALUES ($1, $2, $3, $4, $5, $6)",
      values,
    );
  }
}

async function recall(database: PGlite, question: number[], howMany: number): Promise<string[]> {
  const result = await database.query<{ id: string }>("SELECT id FROM recall($1, $2)", [
    asVector(question),
    howMany,
  ]);
  return result.rows.map((row) => row.id);
}

async function rememberAndRecall(database: PGlite) {
  await actAs(database, "ridgeway");
  const saved = await database.query<{ id: string }>("SELECT remember($1, $2, $3) AS id", [
    "broker_note",
    "Ridgeway decaf lots go under ST-0901-12",
    asVector(NEW_NOTE_MEANING),
  ]);
  const newId = String(saved.rows[0]?.id);
  // A new run is a new connection: the platform sets the importer again from the next token.
  await actAs(database, "fjordline");
  const fjordlineRecall = await recall(database, NEW_NOTE_MEANING, 5);
  await actAs(database, "ridgeway");
  const ridgewayRecall = await recall(database, NEW_NOTE_MEANING, 1);
  return {
    foundNextRun: ridgewayRecall.includes(newId),
    leakedToOthers: fjordlineRecall.includes(newId),
  };
}

type Outcome = {
  loaded?: boolean;
  unforced: string[];
  ridgewayBest: string[];
  supersededSeen: boolean;
  foundNextRun: boolean;
  leakedToOthers: boolean;
};

async function scenario(folder: string): Promise<Outcome> {
  const database = await openPlatformDb(folder);
  try {
    await plantNotes(database);
    const unforced = await unforcedTables(database);
    await actAs(database, "ridgeway");
    const ridgewayBest = await recall(database, QUESTION, 3);
    const nearTheOldRuling = await recall(database, meaning(1, 0.25), 5);
    const supersededSeen = [...ridgewayBest, ...nearTheOldRuling].includes("mem-r0");
    const memory = await rememberAndRecall(database);
    return { loaded: true, unforced, ridgewayBest, supersededSeen, ...memory };
  } finally {
    await database.close();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("scope-memory-per-importer", folder, scenario);
}

export default [
  {
    says: "your SQL files load into Postgres as the role platform",
    test: async (folder) => (await run(folder)).loaded === true,
    tryNext: "read the Postgres error in the output and fix that statement in memory.sql",
  },
  {
    says: "the memory table has row-level security enabled and forced",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && !outcome.unforced.includes("memory");
    },
    tryNext: "give memory the same ENABLE, FORCE and policy as the other importer tables",
  },
  {
    says: "recall for Ridgeway returns its 3 closest notes, though Fjordline's notes are closer",
    test: async (folder) => {
      const best = (await run(folder)).ridgewayBest ?? [];
      return JSON.stringify(best) === JSON.stringify(RIDGEWAY_BEST_THREE);
    },
    tryNext: "filter by importer before you rank and LIMIT, never after",
  },
  {
    says: "recall never returns a superseded ruling",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && outcome.supersededSeen === false;
    },
    tryNext: "add WHERE superseded_by IS NULL inside recall(), before ORDER BY",
  },
  {
    says: "a note remembered in one run is recalled in the next run for the same importer",
    test: async (folder) => (await run(folder)).foundNextRun === true,
    tryNext: "let remember() store importer_id from current_setting('app.importer', true)",
  },
  {
    says: "that note never comes back for another importer",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.loaded === true && outcome.leakedToOthers === false;
    },
    tryNext: "protect the memory table with row-level security, so no query can cross importers",
  },
] satisfies Rule[];

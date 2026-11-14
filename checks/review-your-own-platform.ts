// You review your own platform, not the course's. my-platform/review.md has one row for each of
// the nine layers: what your project uses, its contract, a command that tests it, a saved output
// in evidence/, and a gap with an owner. The check proves the shape and that the evidence exists.
// It never starts the course world and never reads it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";

const LAYERS = [
  "model-gateway",
  "tool-policy",
  "agent-identity",
  "tenancy",
  "memory",
  "run-shapes",
  "durable-runs",
  "traces-and-cost",
  "release-gate",
];
const COURSE_WORDS = /harbourgate|fjordline|ridgeway|northpoint|brokerage|HG-10\d\d/i;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const NONE = /^none\.?$/i;
const COLUMNS = ["layer", "uses", "contract", "test", "evidence", "gap"] as const;

type Row = Record<(typeof COLUMNS)[number], string>;

function readReview(folder: string): string {
  const file = join(folder, "my-platform", "review.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function rowsOf(folder: string): Row[] {
  const tableLines = readReview(folder)
    .split("\n")
    .filter((line) => line.startsWith("| `"));
  return tableLines.map((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const row = Object.fromEntries(COLUMNS.map((name, index) => [name, cells[index] ?? ""]));
    return { ...row, layer: row.layer.replaceAll("`", "") } as Row;
  });
}

const isFilled = (cell: string) => cell.replace(/TODO/i, "").trim().length > 2;
const evidenceFile = (folder: string, row: Row) =>
  join(folder, "my-platform", "evidence", row.evidence);
const hasEvidence = (row: Row) => !NONE.test(row.evidence.trim());

function evidenceProblem(folder: string, row: Row): string | null {
  if (!hasEvidence(row)) return null;
  const file = evidenceFile(folder, row);
  if (!existsSync(file)) return `${row.layer}: evidence/${row.evidence} does not exist`;
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  if (lines.length < 3)
    return `${row.layer}: the evidence file needs the two header lines and output`;
  if (!/^Command: \S/.test(lines[0])) return `${row.layer}: line one must be Command: ...`;
  if (!/^Date: \d{4}-\d{2}-\d{2}$/.test(lines[1]))
    return `${row.layer}: line two must be Date: ...`;
  return null;
}

const hasOwner = (row: Row) => /owner:\s*\S+/i.test(row.gap);

export default [
  {
    says: "review.md names the project, an owner and a review date",
    test: (folder) => {
      const text = readReview(folder);
      const title = text.match(/^# Platform review: (.+)$/m)?.[1] ?? "";
      const owner = text.match(/^Owner: (.+)$/m)?.[1] ?? "";
      const reviewed = text.match(/^Reviewed on: (.+)$/m)?.[1] ?? "";
      return (
        isFilled(title) && isFilled(owner) && DATE.test(reviewed) && !/TODO/.test(title + owner)
      );
    },
    tryNext: "write the project name, Owner: your name and Reviewed on: a date like 2026-01-31",
  },
  {
    says: "there is one row for each of the nine layers",
    test: (folder) => {
      const layers = rowsOf(folder).map((row) => row.layer);
      return (
        layers.length === 9 &&
        LAYERS.every((name) => layers.filter((one) => one === name).length === 1)
      );
    },
    tryNext: `keep one row per layer, name in backticks: ${LAYERS.join(", ")}`,
  },
  {
    says: "every cell of every row is filled",
    test: (folder) => {
      const rows = rowsOf(folder);
      return rows.length === 9 && rows.every((row) => COLUMNS.every((name) => isFilled(row[name])));
    },
    tryNext: "fill every cell; write none in Evidence or Gap where there is nothing to say",
  },
  {
    says: "at least six layers name an evidence file that exists, with its command and date",
    test: (folder) => {
      const withEvidence = rowsOf(folder).filter(hasEvidence);
      const broken = withEvidence.map((row) => evidenceProblem(folder, row)).filter(Boolean);
      return withEvidence.length >= 6 && broken.length === 0;
    },
    tryNext: "save each command's output in evidence/, starting with Command: and Date: lines",
  },
  {
    says: "no two layers share one evidence file",
    test: (folder) => {
      const files = rowsOf(folder)
        .filter(hasEvidence)
        .map((row) => row.evidence);
      return files.length > 0 && new Set(files).size === files.length;
    },
    tryNext: "run a different command for each layer and save its own output",
  },
  {
    says: "a layer with no evidence says what is missing and who owns the fix",
    test: (folder) => {
      const missing = rowsOf(folder).filter((row) => !hasEvidence(row));
      return missing.length > 0 && missing.length <= 3 && missing.every(hasOwner);
    },
    tryNext: "for a layer you cannot test yet, write the gap as: what is missing; owner: a name",
  },
  {
    says: "at least three gaps each have an owner",
    test: (folder) => rowsOf(folder).filter(hasOwner).length >= 3,
    tryNext: "write each gap as: what is missing; owner: a name, and find at least three",
  },
  {
    says: "the review is about your own project, not the course world",
    test: (folder) => {
      const texts = [readReview(folder)];
      for (const row of rowsOf(folder).filter(hasEvidence)) {
        if (existsSync(evidenceFile(folder, row)))
          texts.push(readFileSync(evidenceFile(folder, row), "utf8"));
      }
      return texts[0].length > 0 && texts.every((text) => !COURSE_WORDS.test(text));
    },
    tryNext: "describe your own project and run your own commands; do not copy the course's world",
  },
] satisfies Rule[];

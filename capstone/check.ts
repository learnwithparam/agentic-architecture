// Judges your own platform review: bun capstone/check.ts <folder>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LAYERS = ["Gateway", "Tools", "Identity", "Data", "Run shape", "Trace and cost", "Release"];
const MIN_WORDS = 12;

export function reviewProblems(folder: string): string[] {
  const file = join(folder, "platform-review.md");
  if (!existsSync(file)) return ["platform-review.md is missing"];
  const text = readFileSync(file, "utf8");
  const problems: string[] = [];
  for (const layer of LAYERS) {
    const start = text.indexOf(`## ${layer}`);
    if (start < 0) {
      problems.push(`the review has no "## ${layer}" section`);
      continue;
    }
    const rest = text.slice(start + layer.length + 3);
    const body = rest.split(/\n## /)[0] ?? "";
    const words = body.split(/\s+/).filter(Boolean).length;
    if (/TODO/.test(body)) problems.push(`"${layer}" still says TODO`);
    else if (words < MIN_WORDS)
      problems.push(`"${layer}" needs at least ${MIN_WORDS} words about your own platform`);
  }
  return problems;
}

if (import.meta.main) {
  const problems = reviewProblems(process.argv[2] ?? ".");
  for (const problem of problems) console.error(problem);
  if (problems.length === 0) console.log("Your platform review covers every layer.");
  process.exit(problems.length === 0 ? 0 : 1);
}

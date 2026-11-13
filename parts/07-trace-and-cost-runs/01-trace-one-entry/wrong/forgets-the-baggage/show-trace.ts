// bun show-trace.ts: print the last trace the check received, as a tree.
// Each line is one span, with the attributes this step is about.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type SavedSpan = {
  spanId: string;
  parentSpanId: string;
  name: string;
  attributes: Record<string, string>;
};

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const traceFile = process.env.TRACE_FILE ?? join(ROOT, "world", "state", "last-trace.json");
const SHOWN = [
  "tenant",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "policy.decision",
];

function describe(span: SavedSpan): string {
  const shown = SHOWN.filter((key) => span.attributes[key] !== undefined);
  const pairs = shown.map((key) => `${key.replace("gen_ai.usage.", "")}=${span.attributes[key]}`);
  return `${span.name}  ${pairs.join("  ")}`;
}

function printTree(spans: SavedSpan[], parentId: string, depth: number): void {
  const children = spans.filter((span) => span.parentSpanId === parentId);
  for (const child of children) {
    console.log(`${"  ".repeat(depth)}${describe(child)}`);
    printTree(spans, child.spanId, depth + 1);
  }
}

if (!existsSync(traceFile)) {
  console.log("No trace yet. Run bun run verify trace-one-entry first.");
  process.exit(1);
}
const spans: SavedSpan[] = JSON.parse(readFileSync(traceFile, "utf8"));
const knownIds = new Set(spans.map((span) => span.spanId));
const roots = spans.filter((span) => !knownIds.has(span.parentSpanId));
console.log(`${spans.length} spans, ${roots.length} root(s):`);
for (const root of roots) {
  console.log(describe(root));
  printTree(spans, root.spanId, 1);
}

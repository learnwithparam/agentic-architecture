// biome-ignore-all lint/style/useNamingConvention: settings like FORCE_COLOR are in capitals.
// Captures images/expected.png from the real commands, rendered as a dark terminal.
// Needs Playwright's Chromium. Run from the repo root:
//   bun parts/09-swap-and-review/02-pass-the-platform-review/capture.ts
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const STEP = "parts/09-swap-and-review/02-pass-the-platform-review/";
const COMMANDS = [`bun ${STEP}review-card.ts solution`];

type Page = {
  setContent: (html: string) => Promise<void>;
  locator: (selector: string) => { screenshot: (options: { path: string }) => Promise<unknown> };
};
type Browser = { newPage: (options: object) => Promise<Page>; close: () => Promise<void> };

async function outputOf(command: string): Promise<string> {
  const child = Bun.spawn(["sh", "-c", command], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const printed = await new Response(child.stdout).text();
  await child.exited;
  return printed.trimEnd();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function colourLines(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/^(\s+0 {2}.*)$/gm, '<span class="ok">$1</span>');
  return html;
}

const STYLE = `<style>
  body{margin:0;background:#0d1117;color:#c9d1d9;
    font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}
  .win{width:800px;padding:14px 18px 18px;box-sizing:border-box}
  .cmd{color:#79c0ff;margin-top:6px}
  pre{margin:2px 0 10px;white-space:pre-wrap}
  .ok{color:#56d364}
  .bad{color:#f85149}
  </style>`;

async function terminalHtml(): Promise<string> {
  const blocks: string[] = [];
  for (const command of COMMANDS) {
    const output = await outputOf(command);
    const shortCommand = command.replace(STEP, "");
    blocks.push(`<div class="cmd">$ ${escapeHtml(shortCommand)}</div>`);
    blocks.push(`<pre>${colourLines(output)}</pre>`);
  }
  return `<!doctype html><meta charset="utf-8">${STYLE}<div class="win">${blocks.join("")}</div>`;
}

const { chromium } = require("playwright") as { chromium: { launch: () => Promise<Browser> } };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 400 }, deviceScaleFactor: 2 });
await page.setContent(await terminalHtml());
const picture = join(import.meta.dir, "images", "expected.png");
await page.locator(".win").screenshot({ path: picture });
await browser.close();
console.log(`Wrote ${picture}`);

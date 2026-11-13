// biome-ignore-all lint/style/useNamingConvention: settings like FORCE_COLOR are in capitals.
// Captures the pictures this part shows, from the real commands, rendered as a dark terminal.
// Needs Playwright's Chromium: `bunx playwright install chromium` if you do not have it.
// Run: bun parts/06-survive-a-crash/01-resume-a-killed-run/images/capture.ts
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

// Only the parts of Playwright this script uses.
type Page = {
  setContent: (html: string) => Promise<void>;
  locator: (selector: string) => { screenshot: (options: { path: string }) => Promise<unknown> };
};
type Browser = {
  newPage: (options: object) => Promise<Page>;
  close: () => Promise<void>;
};
type Playwright = { chromium: { launch: () => Promise<Browser> } };

// Use the project's Playwright when it is installed, otherwise the copy the machine provides.
function loadPlaywright(): Playwright {
  try {
    return require("playwright");
  } catch {
    return require(process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/playwright");
  }
}

// Run one command the way a learner would, and keep everything it prints.
async function outputOf(command: string): Promise<string> {
  const child = Bun.spawn(["sh", "-c", command], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LLM_PROVIDER: "replay", FORCE_COLOR: "0" },
  });
  const standardOutput = await new Response(child.stdout).text();
  const errorOutput = await new Response(child.stderr).text();
  await child.exited;
  const printed = standardOutput + errorOutput;
  // Drop the "$ bun ..." lines that bun run echoes, so the picture shows only the output.
  return printed.replace(/^\$ .*\n/gm, "").trimEnd();
}

function escapeHtml(text: string): string {
  const withoutAmpersands = text.replace(/&/g, "&amp;");
  return withoutAmpersands.replace(/</g, "&lt;");
}

// Colour PASS lines and zero counts green, and FAIL lines red.
function colourLines(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/^(\s*PASS\b.*)$/gm, '<span class="ok">$1</span>');
  html = html.replace(/^(\s*FAIL\b.*)$/gm, '<span class="bad">$1</span>');
  html = html.replace(/^(\s+0 {2}.*)$/gm, '<span class="ok">$1</span>');
  return html;
}

const STYLE = `<style>
  body{margin:0;background:#0d1117;color:#c9d1d9;
    font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}
  .win{width:800px;padding:14px 18px 18px;box-sizing:border-box}
  .bar{display:flex;gap:6px;margin-bottom:12px}
  .bar i{width:11px;height:11px;border-radius:50%;background:#30363d;display:block}
  .cmd{color:#79c0ff;margin-top:6px}
  pre{margin:2px 0 10px;white-space:pre-wrap}
  .ok{color:#56d364}
  .bad{color:#f85149}
  </style>`;

type Block = { command: string; output: string };

function terminalHtml(blocks: Block[]): string {
  const commandsAndOutputs = blocks.map((block) => {
    const command = `<div class="cmd">$ ${escapeHtml(block.command)}</div>`;
    return `${command}<pre>${colourLines(block.output)}</pre>`;
  });
  const windowBar = '<div class="bar"><i></i><i></i><i></i></div>';
  const body = commandsAndOutputs.join("");
  return `<!doctype html><meta charset="utf-8">${STYLE}<div class="win">${windowBar}${body}</div>`;
}

// The pictures this part's pages show. The supervisor can move these lines into images/capture.ts.
const SHOTS: { file: string; commands: string[] }[] = [
  {
    file: "parts/06-survive-a-crash/01-resume-a-killed-run/images/expected.png",
    commands: ["bun run before", "bun run verify resume-a-killed-run solution"],
  },
];

const browser = await loadPlaywright().chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 200 }, deviceScaleFactor: 2 });
for (const shot of SHOTS) {
  const blocks: Block[] = [];
  for (const command of shot.commands) {
    blocks.push({ command, output: await outputOf(command) });
  }
  await page.setContent(terminalHtml(blocks));
  await page.locator(".win").screenshot({ path: join(ROOT, shot.file) });
  console.log(`Captured ${shot.file}`);
}
await browser.close();

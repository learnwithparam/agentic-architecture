// Captures every picture the READMEs show, from the real commands, rendered as a dark terminal.
// Needs Playwright's Chromium: `bunx playwright install chromium` if you do not have it.
// Run: bun images/capture.ts
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let chromium: any;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/playwright")); }

async function run(cmd: string) {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, LLM_PROVIDER: "replay", FORCE_COLOR: "0" } });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  await p.exited;
  return out.replace(/^\$ .*\n/gm, "").trimEnd();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const color = (s: string) => esc(s)
  .replace(/^(\s*PASS\b.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(\s*FAIL\b.*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(\s+0  .*)$/gm, '<span class="ok">$1</span>');

function html(blocks: { cmd: string; out: string }[]) {
  const body = blocks.map((b) => `<div class="cmd">$ ${esc(b.cmd)}</div><pre>${color(b.out)}</pre>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0d1117;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#c9d1d9}
  .win{width:800px;padding:14px 18px 18px;box-sizing:border-box}
  .bar{display:flex;gap:6px;margin-bottom:12px}.bar i{width:11px;height:11px;border-radius:50%;background:#30363d;display:block}
  .cmd{color:#79c0ff;margin-top:6px}pre{margin:2px 0 10px;white-space:pre-wrap}.ok{color:#56d364}.bad{color:#f85149}
  </style><div class="win"><div class="bar"><i></i><i></i><i></i></div>${body}</div>`;
}

const shots: { file: string; cmds: string[] }[] = [
  { file: "images/finished-system.png", cmds: ["bun run after"] },
  { file: "00-orientation/images/after.png", cmds: ["bun run before", "bun run after"] },
  { file: "parts/00-meet-the-brokerage/01-meet-the-brokerage/images/expected.png", cmds: ["bun run before", "bun run after"] },
  { file: "parts/01-route-model-calls/01-route-calls-through-gateway/images/expected.png", cmds: ["bun run verify route-calls-through-gateway solution", "bun run spend"] },
  { file: "parts/01-route-model-calls/03-cap-spend-per-importer/images/expected.png", cmds: ["bun run verify cap-spend-per-importer solution", "bun run spend"] },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 200 }, deviceScaleFactor: 2 });
for (const s of shots) {
  const blocks = [];
  for (const c of s.cmds) blocks.push({ cmd: c, out: await run(c) });
  await page.setContent(html(blocks));
  await page.locator(".win").screenshot({ path: join(ROOT, s.file) });
  console.log(`Captured ${s.file}`);
}
await browser.close();

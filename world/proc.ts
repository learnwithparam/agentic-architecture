// Start a service as a child process on a free port and wait until /health answers.
import type { Subprocess } from "bun";

export function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port!;
  s.stop(true);
  return p;
}

export type Service = {
  url: string;
  proc: Subprocess;
  output: () => string;
  stop: () => Promise<void>;
};

const running = new Set<Subprocess>();
process.on("exit", () => {
  for (const p of running) p.kill(9);
});

export async function startService(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; waitMs?: number },
): Promise<Service> {
  const port = freePort();
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.add(proc);
  let out = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) out += new TextDecoder().decode(c);
  };
  drain(proc.stdout as ReadableStream<Uint8Array>);
  drain(proc.stderr as ReadableStream<Uint8Array>);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.waitMs ?? 8000);
  const stop = async () => {
    proc.kill(9);
    await proc.exited;
    running.delete(proc);
  };
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    const ok = await fetch(`${url}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return { url, proc, output: () => out, stop };
    await Bun.sleep(50);
  }
  await stop();
  throw new Error(
    `${cmd.join(" ")} did not answer /health on port ${port}. Its output:\n${out.trim() || "(nothing)"}`,
  );
}

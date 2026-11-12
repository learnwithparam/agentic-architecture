// biome-ignore-all lint/style/useNamingConvention: environment variable names are UPPER_CASE.
// Start a service as a child process on a free port and wait until /health answers.
import type { Subprocess } from "bun";

export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Could not find a free port.");
  return port;
}

export type Service = {
  url: string;
  proc: Subprocess;
  output: () => string;
  stop: () => Promise<void>;
};

// Every child we start is killed when this process exits, so no service is left running.
const running = new Set<Subprocess>();
process.on("exit", () => {
  for (const child of running) child.kill(9);
});

type StartOptions = { cwd: string; env: Record<string, string>; waitMs?: number };

// Collect everything the child prints, so a failure can show it.
function collectOutput(child: Subprocess): () => string {
  let output = "";
  const decoder = new TextDecoder();
  const readStream = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  readStream(child.stdout as ReadableStream<Uint8Array>);
  readStream(child.stderr as ReadableStream<Uint8Array>);
  return () => output;
}

async function answersHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function startService(command: string[], options: StartOptions): Promise<Service> {
  const port = freePort();
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.add(child);
  const output = collectOutput(child);
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill(9);
    await child.exited;
    running.delete(child);
  };

  const deadline = Date.now() + (options.waitMs ?? 8000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await answersHealth(url)) return { url, proc: child, output, stop };
    await Bun.sleep(50);
  }
  await stop();
  const printed = output().trim() || "(nothing)";
  const problem = `${command.join(" ")} did not answer /health on port ${port}.`;
  throw new Error(`${problem} Its output:\n${printed}`);
}

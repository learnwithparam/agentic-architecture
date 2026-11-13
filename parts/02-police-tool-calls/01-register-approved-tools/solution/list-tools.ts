// bun list-tools.ts: prints every tool the servers offer today, with the pin to copy into
// tools.yaml. Review each description before you approve a tool.
import { join } from "node:path";

type ServerTools = Record<string, string>;

const toolServersFile = join(import.meta.dir, "..", "..", "tool-servers.json");
const toolServers = (await Bun.file(toolServersFile).json()) as {
  servers: Record<string, ServerTools>;
};

function pinOf(description: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(description).digest("hex");
  return `sha256:${hash.slice(0, 16)}`;
}

for (const [server, tools] of Object.entries(toolServers.servers)) {
  console.log(`# server: ${server}`);
  for (const [name, description] of Object.entries(tools)) {
    console.log(`  - name: ${name}\n    pin: ${pinOf(description)}\n    # ${description}`);
  }
}

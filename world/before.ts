// bun run before: reset the world, run the three team scripts as they are now, print the report card.
import { join } from "node:path";
import { card, printCard } from "./report";
import { runBefore } from "./scenario";
import { startWorld } from "./services";

const world = await startWorld({ reset: true });
try {
  await runBefore(world, join(import.meta.dir, "state", "before"));
  printCard("Harbourgate before the platform:", card(world.db, join(import.meta.dir, "legacy")));
} finally {
  world.stop();
}

# Meet the brokerage

## The problem

Harbourgate Brokerage clears goods through the Port of Saltmere for three importers. Three teams each
built their own agent, each in their own way. Nobody can say what the agents did, for whom, or what it
cost. Before you build any layer, you need the numbers that show what is wrong now.

![The report card before and after the platform](../images/expected.png)

## Your challenge

Run the three team scripts as they are now, read the report card, and record it in `platform.toml`
in this folder. That file is your platform's address book; later parts add to it.

1. Run `bun run world` and read the importers, the teams and the open queue.
2. Run `bun run before` and read the six numbers.
3. Run `bun run after` to see the same queue on the finished platform.
4. Fill in `platform.toml`: your name, your run mode, and the six numbers from `bun run before`.

```bash
bun run verify meet-the-brokerage
```

Expect: `Done. All 10 rules pass.`

## Done when

- The world starts and its open queue has 12 shipments.
- `platform.toml` names you and a run mode: `replay`, `anthropic`, `openrouter`, `openai` or `ollama`.
- Each of the six numbers under `[before]` matches what `bun run before` printed.

## If you get stuck

| What you see | Fix |
|---|---|
| `FAIL run_mode is one of ...` | Use `replay` unless you put a key in `.env`. |
| `FAIL you recorded how many ...` | Run `bun run before` again and copy the number from that line. The world resets each run, so the numbers do not change. |
| `FAIL the world starts ...` | Run `bun run world reset` and read [troubleshooting](../../../../00-orientation/troubleshooting.md). |

## Words you will use

- **Importer**: a company whose goods Harbourgate clears. Each importer is a tenant of the platform and must never see another's papers.
- **Entry**: the filing that tells customs what is in a container and what duty is owed.
- **Tariff code**: the line in the tariff schedule that a good falls under. A licensed broker must sign every code.
- **Hold**: customs stops a container for an exam. The container waits, and the waiting costs money.
- **Replay mode**: the models answer from recorded replies, so everything runs with no key.

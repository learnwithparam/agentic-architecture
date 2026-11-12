# Parts: what is built and what each part session builds

This file is for the sessions that build the remaining parts. A part session can start from it alone.

## How the repo is laid out

- `world/`: Harbourgate Brokerage. `world/data/` holds the importers, teams (with their virtual keys), brokers,
  the teaching tariff, budgets, provider prices and 60 shipments (12 open). `bun world/build-data.ts` rebuilds
  `shipments.json` and `replay/replies.json` from a fixed seed. `world/db.ts` is the SQLite system of record;
  `world/services.ts` starts the tools and ledger API and the two fake providers (a and b) in-process on free
  ports. Tables a check can read: `spend_log`, `provider_calls`, `tool_audit`, `reads`, `entries`,
  `entry_lines`, `proposals`, `signatures`, `holds`, `payments`, `emails`, `spans`.
- Planted faults in the open queue: rush shipments `HG-1049` and `HG-1053` (the legacy Classification script
  files them unsigned), the mislabelled glove line `HG-1051-L1`, the hidden instruction in `HG-1055`'s invoice
  notes, the missing packing list on `HG-1058`, and customs holds on `HG-1050` (x-ray) and `HG-1057` (tailgate).
- `world/legacy/`: the three team scripts as they are now. `bun run before` runs them and prints the report card.
- `teams/`: the same agents written against the platform client `teams/lib/platform.ts`. `bun run after` runs
  them on `reference/`, the finished platform: `gateway.ts` (keys, routes, fallback, budgets, spend, spans),
  `services.ts` (token service, tool gateway with `policy.json` and broker sign-off, run journal).
  The reference is deliberately small: policy is a JSON allow list, tenancy is a filter the tool gateway adds,
  durability is a SQLite journal. Each part replaces one of these with the real thing.
- `checks/lib/`: `freshWorld()` (a reset world in `world/state/check.db`), `startLearner(dir, service, env)`
  (runs the `[service] start` command from the learner's `platform.toml` and waits for `/health`),
  `once(key, dir, scenario)` (runs a scenario once per folder for all rules), `threeRuns()` (judge model-dependent
  behaviour over three fresh replay runs), `chat()` and `gatewayEnv()` for gateway checks.
- Rules for every check: start the learner's work through `platform.toml`, drive it over HTTP, read the world's
  tables. Never import the learner's code and never judge a model's reply text.

## Constraint every part session must keep

CI runs `bun run check` with Bun only: no Docker. Every check must run in process. Use `@electric-sql/pglite`
(Postgres in WebAssembly, supports row-level security and pgvector) for the tenancy part, an in-process engine
or the existing journal pattern for durable runs, and an in-process trace store for traces. Products that need
a server (Restate, Temporal, Jaeger, LiteLLM) belong in the swap part as optional, outside CI.

## Moving a part into place

Outlines live in `parts-planned/NN-<name>/README.md` because `scripts/check.ts` fails any folder under
`parts/` that has no steps. When you build a part: `git mv parts-planned/NN-<name> parts/NN-<name>`, add the
step folders, replace every `TODO(part session)`, and add the "Why it matters" number only after you open the
company's page and quote it (the build session could not reach any company page, so no number is shown yet).
`schedules.toml` already lists every part by name.

## Built

| Part folder | Steps (minutes) | What each step's check reads |
|---|---|---|
| `parts/00-meet-the-brokerage` | `meet-the-brokerage` (20) | A fresh world's open queue; `platform.toml` `[learner]` and `[before]` against the report card from running `world/legacy/` |
| `parts/01-route-model-calls` | `route-calls-through-gateway` (20), `fall-back-on-outage` (15), `cap-spend-per-importer` (20) | Status codes; `provider_calls.key_owner`; `spend_log` against `provider_calls` to the micro-dollar; the `x-gateway-provider` header with provider a down; `provider_error` rows; whether a bad `ROUTES_FILE` starts; 402s and spend per importer against `world/data/budgets.json`; billed roles; `teams/` for `pk-` keys |

## To build

| Part folder | Steps (minutes) | What each step's check reads |
|---|---|---|
| `parts-planned/02-police-tool-calls` | `register-approved-tools` (15), `deny-the-planted-call` (20), `require-broker-signoff` (15) | `tools/list` through the learner's tool gateway; a planted tool whose hash changed; every cell of `checks/policy-table.csv` against the decision; `tool_audit` for the planted `file_entry`; fail closed with the policy engine down; `entry_lines.signed_by` (0 unsigned); a trainee's signature refused |
| `parts-planned/03-identify-each-agent` | `issue-agent-identities` (15), `exchange-tokens-per-call` (20) | 401 for expired and wrong-audience tokens; `tool_audit.agent` on every row; 403 for a Northpoint token on a Fjordline container; the token a fake upstream tool received is never the agent's own |
| `parts-planned/04-separate-importer-data` | `isolate-importer-data` (20), `scope-memory-per-importer` (15) | Queries as each importer on every table; forced row-level security on every table with an `importer_id`; `reads` across importers drops to 0; memory recall with a planted near-identical note; superseded rulings never returned |
| `parts-planned/05-choose-run-shapes` | `run-both-shapes` (20) | Both shapes complete on 3 shipments; `stopped_at_limit`; one `run_id` across `spend_log`, `tool_audit` and `spans`; `decisions/run-shape.md` sections |
| `parts-planned/06-survive-a-crash` | `resume-a-killed-run` (25), `release-the-container-once` (15) | A worker killed after `pay_exam_fee` (guard: it really died); `payments` shows 1; model calls equal decision steps; duplicate release events cause 1 release; a whole-run replay moves no money |
| `parts-planned/07-trace-and-cost-runs` | `trace-one-entry` (20), `split-cost-by-importer` (15) | Spans for one entry: one trace, `tenant` on every span, token counts, policy decisions, no sensitive field; `bun run costs` against the providers' bill; an untagged batch job shown as unattributed |
| `parts-planned/08-gate-each-release` | `block-a-bad-release` (25) | `bun run gate` exit codes on the planted bad prompt and the current one; the cost ceiling; `out/gate.json` against its schema. Uses the `HG-1051-L1` glove line |
| `parts-planned/09-swap-and-review` | `swap-one-layer` (25), `pass-the-platform-review` (20) | `bun run verify --all` with the swapped layer; no change under `teams/`; `decisions/swap.md`; `review/platform.md` rows naming passing checks; `bun run onboard` for a Billing agent |

Total with the built parts: 360 minutes.

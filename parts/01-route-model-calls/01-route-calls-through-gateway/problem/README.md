# Route calls through a gateway

## The problem

The report card says 41 model calls went straight to a provider. It also says 3 provider keys sit in team code. So any team can
spend without limit. If a key leaks, anyone can run up Harbourgate's bill. And finance cannot split the cost by importer.

```mermaid
flowchart LR
  T[Team agent with its team key] -->|x-importer| G[Your gateway]
  G -->|401| X[Unknown key]
  G -->|platform key| A[Provider a]
  G -->|one row per call| L[(Spend log)]
```

## Watch it done

Run `bun run verify route-calls-through-gateway` on the starter, and see it fail. Then run it again with `solution` at the end,
and see it pass.

## Your turn

Today `gateway.ts` is a pass-through. It sends every call on, unchanged. Turn it into the one door for model calls:

1. Read the caller's "Authorization: Bearer <team key>". Find the team with that key in `TEAMS_FILE`. If no team has it, answer
   401.
2. Call provider a with `PROVIDER_A_KEY`, the platform's own key. Never pass on the caller's key.
3. Work out the cost from the token counts that the provider sent back, and the prices in `PROVIDERS_FILE`.
4. Send one row to `LEDGER_URL/spend` with `team`, `importer`, `role`, `provider`, `tokens_in`, `tokens_out` and
   `cost_micros`.
5. Take the provider key out of `teams/paperwork.ts`. Send `process.env.TEAM_KEY` instead.

For example, a `fast` call that used 120 tokens in and 30 out costs 120 × 1 + 30 × 4 = 240 micro-dollars.

The check starts your gateway with the command in `platform.toml`. So you can write the gateway in any language.

```bash
bun run verify route-calls-through-gateway
bun run spend
```

Expect: `Done. All 8 rules pass.`, then a spend table that ends `They match.`

![Spend by importer and team, matching the providers' bill](../images/expected.png)

## Do it on your work

Find one place in your own code that calls a model directly. List who owns the key, and where the calls are logged today. Use
your own files. A good answer gives proof for each line below.

## Done when

- A call with no key, or an unknown key, gets 401.
- A call with each team's key is answered.
- The provider only ever saw the platform's key.
- Every answered call wrote one spend row. The spend log adds up to the providers' bill to the micro-dollar.
- `teams/` holds no provider key.

## Solution

The after state is in `solution/`. Compare it with `diff -r problem/ solution/`.

## If you get stuck

| What you see                                   | Fix                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAIL a call with each team's key is answered` | The provider got a key it does not know. Send `PROVIDER_A_KEY`.                                                                                                                                                                          |
| `FAIL the spend log adds up ...`               | Use `usage.prompt_tokens` and `usage.completion_tokens` from the reply, times the prices for that role. Do not guess from text length.                                                                                                   |
| `FAIL your gateway starts ...`                 | In this folder, run `PORT=4000 TEAMS_FILE=../../../../world/data/teams.json PROVIDERS_FILE=../../../../world/data/providers.json bun gateway.ts` and read the error. The check sets these files for you. By hand, you set them yourself. |

## Words you will use

- **Gateway**: one service that every model call passes through. Keys, limits and records then live in one place.
- **Virtual key**: a key the platform gives a team. It only works at the gateway. You can cancel it without touching a provider.
- **Role**: what a call asks for: `fast`, `smart` or `judge`. The gateway decides which model plays that role.
- **Micro-dollar**: one millionth of a US dollar. Costs stay whole numbers, so sums are exact.

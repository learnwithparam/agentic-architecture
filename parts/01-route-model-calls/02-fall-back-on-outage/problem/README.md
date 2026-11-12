# Fall back on outage

## The problem

When provider a has an outage, every agent at Harbourgate stops: no codes, no drafts, containers wait.
A fallback fixes that, but a careless one quietly answers hard tariff questions with a weaker model.

```mermaid
flowchart LR
  G[Gateway] -->|1st try| A[Provider a]
  A -->|down| G
  G -->|2nd try, same tier or stronger| B[Provider b]
  G -->|provider_error row| L[(Spend log)]
  R[routes.json] -->|checked at start| G
```

## Your challenge

Use `routes.json`: for each role, the hops to try in order, written `provider:role`.

1. Try each hop in order. Return the first answer, with header `x-gateway-provider` set to the provider that answered.
2. Log every failed try as a spend row with `status: "provider_error"` and cost 0.
3. Price each answer with the prices of the provider that gave it.
4. At start, exit with an error if any hop is a weaker role than the one asked for. `fast` and `judge` are tier 1, `smart` is tier 2.

```bash
bun run verify fall-back-on-outage
```

Expect: `Done. All 6 rules pass.`

## Done when

- With both providers up, calls go to provider a.
- With provider a down, all 10 calls are answered by provider b.
- Each failed try is in the spend log, and the log still adds up to the bill.
- A route that falls back to a weaker model is refused at start.

## If you get stuck

| What you see | Fix |
|---|---|
| `FAIL ... still answered (200)` | Catch the failed fetch or the non-200 status and move to the next hop. |
| `FAIL ... refused at start` | Check the routes before `Bun.serve`, and call `process.exit(1)` on a bad hop. |
| `FAIL ... adds up to the providers' bill` | Provider b has its own prices in `PROVIDERS_FILE`. |

## Words you will use

- **Route**: the ordered list of providers a gateway tries for one role.
- **Fallback**: the next hop, used only when the one before it failed.
- **Tier**: how strong a role is. A fallback may stay level or go up, never down.

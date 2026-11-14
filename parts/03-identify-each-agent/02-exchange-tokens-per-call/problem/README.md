# Exchange tokens per call

## The problem

Each agent has its own token, but one token still opens every door.
If the Holds agent's token leaks from one tool server, anyone can pay fees for any importer's container.
The audit log also cannot say which broker the agent worked for.

```mermaid
flowchart LR
  A[Holds agent] -->|own token + tool, importer, broker| T[Token service: /exchange]
  T -->|scoped token: aud tool:book_exam, importer northpoint, sub amara-okafor, act holds-agent| A
  A -->|scoped token| G[Tool gateway]
  G -->|right tool and importer?| S[Tool servers]
  G -->|own token, wrong tool or wrong importer| X[Refused]
```

## Watch it done

Run `bun run verify exchange-tokens-per-call` on the starter and see it fail. Run it again with `solution` on the end and see it pass.

## Your turn

Before each tool call, the agent swaps its own token for a scoped one.
A scoped token works for one tool and one importer, on behalf of one broker.

1. In `token-service.ts`, finish `exchangeToken()`. Check `subject_token` with `jwtVerify`, or answer 401.
2. Refuse with 403 when `on_behalf_of` is not a broker, or is not licensed for a tool in `BROKER_ONLY_TOOLS`.
3. Sign the scoped token. `sub` is the broker. "act: { sub }" is the agent. Add `importer`, and audience `tool:<tool>`.
4. In `tool-gateway.ts`, accept only audience `tool:<name>` for the tool in the URL. Refuse the agent's own token.
5. Refuse a call when the shipment belongs to another importer. Set `x-agent` from `act.sub` and `x-importer` from the token.
6. Never pass the agent's own token on to a tool server.

This shape comes from token exchange in RFC 8693, a public standard.

For example, a token for `book_exam` on Northpoint works on `HG-1057` (Northpoint). On `HG-1050` (Ridgeway) it gets 403.

```bash
bun run verify exchange-tokens-per-call
bun run verify part identify-each-agent
```

Expect: `Done. All 9 rules pass.`, then `Part identify-each-agent is done: 2/2 steps pass.`

![The check passing on the sample answer](../images/expected.png)

## Do it on your work

Pick one agent call. Show the token it uses, what the token allows, and when it ends. Use your own files. Good looks like proof for each line below.

## Done when

- `/exchange` gives a token for one tool and one importer, with the broker in `sub` and the agent in `act`.
- The token fails on another importer's container, on another tool, and the agent's own token fails at the gateway.
- No tool server ever receives the agent's own token.
- An exchange for `pay_fee` on behalf of the trainee is refused.

## Solution

The after state is in `solution/`. Compare it with `diff -r problem solution`.

## If you get stuck

| What you see                                | Fix                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `FAIL a Northpoint token on Ridgeway's ...` | Ask the world who owns `shipment_id`, then compare it with the token's `importer`.  |
| `FAIL the agent's own token is refused ...` | The audience must be exactly `tool:<name>`. Do not also accept `harbourgate-tools`. |
| `FAIL the tool servers never received ...`  | Build new headers. Do not copy the caller's `authorization` header.                 |

## Words you will use

- **Token exchange**: trading one token for another, narrower one.
- **Scope**: what a token may be used for. Here: one tool and one importer.
- **Actor chain**: who acted for whom. `sub` is the broker, `act.sub` is the agent acting for the broker.
- **Passthrough**: sending the caller's own token on to the next service. It spreads a powerful secret.

# Issue agent identities

## The problem

Every tool call carries a team key such as `hgk_paperwork_b2c604`. It never ends, and every tool server sees it.
If one leaks, anyone can act as that team.
The gateway also trusts the `x-agent` header the caller wrote, so any caller can claim to be the Holds agent.

```mermaid
flowchart LR
  A[Agent] -->|agent name and secret| T[Token service]
  T -->|signed token: sub, team, aud, exp| A
  A -->|Bearer token| G[Tool gateway]
  G -->|GET /jwks: public key| T
  G -->|x-agent from the token| S[Tool servers]
```

## Watch it done

Run `bun run verify issue-agent-identities` on the starter and see it fail. Run it again with `solution` on the end and see it pass.

## Your turn

Give each agent its own short-lived token, and accept nothing else at the tool gateway.

1. In `token-service.ts`, finish `issueToken()`. Check the agent and secret against `TEAMS_FILE`. Answer 401 if they do not match.
2. Sign a token with `SignJWT` from `jose`: subject is the agent, a `team` claim, issuer `harbourgate-tokens`, audience `harbourgate-tools`, and an expiry after `LIFETIME_SECONDS`. That constant is already at the top of `token-service.ts`.
3. In `tool-gateway.ts`, drop the team keys. Check each token with `jwtVerify` against `TOKENS_URL/jwks`, with the issuer and audience above.
4. Set `x-agent` from the token's `sub`, never from the caller's headers.

The key pair and `/jwks` are already done in `token-service.ts`.

For example, the Paperwork agent sends '{ "agent": "paperwork-agent", "secret": "hgk_paperwork_b2c604" }' to `/token`.
It gets back a token. Decoded, the token says:

```json
{ "sub": "paperwork-agent", "team": "paperwork", "aud": "harbourgate-tools", "exp": 1789000300 }
```

The agent then calls `read_shipment` with "Authorization: Bearer <token>".
Five minutes later the token has ended, and the same call gets 401.

```bash
bun run verify issue-agent-identities
```

Expect: `Done. All 9 rules pass.`

![The check passing on the sample answer](../images/expected.png)

## Do it on your work

List the agents on your platform. Check that each one has its own name and its own key, not a shared one. Use your own files. Good looks like proof for each line below.

## Done when

- Each agent gets a token that names it and ends soon after it is made.
- A wrong secret, an expired token, a token for another audience and a forged token all get 401.
- A raw team key no longer works at the tool gateway.
- Every audit row names the agent from the token.

## Solution

The after state is in `solution/`. Compare it with `diff -r problem solution`.

## If you get stuck

| What you see                                  | Fix                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `FAIL an expired token gets 401`              | Use the `LIFETIME_SECONDS` constant for the expiry. It reads `TOKEN_TTL_SECONDS`, and the check sets that to 2 seconds. |
| `FAIL a token made for another audience ...`  | Pass `audience: "harbourgate-tools"` to `jwtVerify`.                                                                    |
| `FAIL a token signed with someone else's key` | `decodeJwt` only reads a token. `jwtVerify` checks the signature too.                                                   |

## Words you will use

- **Token**: a signed note that says who you are and when the note ends. Here it is a JWT.
- **Claim**: one fact inside a token, such as `sub` (who) or `exp` (when it ends).
- **Audience**: who a token is for. A token for billing must not work at the tool gateway.
- **JWKS**: the public keys of the token service. Anyone can check a signature with them, but nobody can sign.

# Gate each release

## The problem

Someone changed the Classification prompt.
It looked better on five examples, so it went out.
Then it gave Northpoint's gloves the wrong tariff code.
Nothing stood between the change and customs.

## Why it matters

DoorDash tests its Ask DoorDash agent with fake conversations.
It grades the agent with the same rules before release and in real use ([DoorDash Engineering](https://careersatdoordash.com/blog/building-ask-doordash-part-three-evaluation/)).
For example, your gate will block the prompt change above before it reaches customs.

```mermaid
flowchart LR
  CH[Prompt or model change] --> GS[Golden set: broker-labelled lines]
  GS --> GR[Grader]
  GR --> TH{gate.yaml thresholds}
  TH -->|never-do metric above 0, or pass rate below floor| BL[Blocked]
  TH -->|all met| OK[Released]
```

| Step                  | Minutes | What you produce                                                                               | What its check reads                                                                                                                                                        |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `block-a-bad-release` | 25      | `gate.yaml` with zero tolerance for never-do metrics and a pass-rate floor, and `bun run gate` | Exit code 1 on the planted bad prompt with the failing lines named; exit 0 on the current prompt; a change above the cost ceiling fails; `out/gate.json` against its schema |

## Walkthrough

TODO(part session): the steps do not exist yet. These are the commands this part will use.

```bash
bun run verify block-a-bad-release
bun run verify part gate-each-release
```

Expect: TODO(part session)

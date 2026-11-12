# Choose run shapes

## The problem

Classification is a fixed path, Holds needs an agent that decides its next step, and each team built its own runner. Nothing is shared: not identity, not budgets, not the record of a run.

## Why it matters

Allianz describes Project Nemo, a claims flow of several agents with a planner and human handlers for likely rejections ([Allianz](https://www.allianz.com/en/mediacenter/news/articles/251103-when-the-storm-clears-so-should-the-claim-queue.html)).

```mermaid
flowchart LR
  API[Run API: POST /runs, GET /runs/:id] --> WF[Workflow runner: Classification]
  API --> AL[Agent loop with a step limit: Holds]
  WF & AL --> GW[Model gateway]
  WF & AL --> TG[Tool gateway]
```

| Step              | Minutes | What you produce                                                                                          | What its check reads                                                                                                                                                                            |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-both-shapes` | 20      | A run API that starts either a workflow or an agent loop with a step limit, plus `decisions/run-shape.md` | Both shapes complete on 3 shipments; a loop that hits its limit ends `stopped_at_limit`; every call in a run carries the same `run_id` in the spend log and audit; the decision file's sections |

## Walkthrough

TODO(part session): the steps do not exist yet. These are the commands this part will use.

```bash
bun run verify run-both-shapes
bun run verify part choose-run-shapes
```

Expect: TODO(part session)

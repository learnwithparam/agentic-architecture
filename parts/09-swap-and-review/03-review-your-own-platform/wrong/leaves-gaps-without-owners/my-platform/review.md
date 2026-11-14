# Platform review: Marlow Bakery order agent

Owner: Jo Marlow
Reviewed on: 2026-03-02

The review covers the order agent that takes orders from three bakery branches.

| Layer             | What my platform uses                            | Contract                                                      | How I test it                             | Evidence            | Gap and who fixes it                         |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------- | ------------------- | -------------------------------------------- |
| `model-gateway`   | `gateway/proxy.py`, one key per team             | Every model call goes through `POST /v1/chat` with a team key | `curl` with a wrong key, then a right key | model-gateway.txt   | no spend cap yet                             |
| `tool-policy`     | `tools/allow.yaml`, read at start                | A tool not in the list is refused with 403                    | `python tools/try_denied.py`              | tool-policy.txt     | none                                         |
| `agent-identity`  | Short-lived tokens from our login service        | Each agent has its own token that ends soon after it is made  | `python auth/show_claims.py`              | agent-identity.txt  | agents still share one token in the cron job |
| `tenancy`         | Row-level security on the `orders` table         | A bakery branch only reads its own orders                     | `psql -f tests/branch_a_reads_b.sql`      | tenancy.txt         | none                                         |
| `memory`          | `notes` table keyed by branch                    | Recall never returns another branch's note                    | `python tests/recall_other_branch.py`     | memory.txt          | old notes are never replaced                 |
| `run-shapes`      | A fixed script for the order flow                | The order flow has a step limit of 8                          | `python run_order.py --limit 8`           | run-shapes.txt      | none                                         |
| `durable-runs`    | None                                             | A killed run resumes and does not charge twice                | None yet                                  | none                | a crash charges the card twice               |
| `traces-and-cost` | Logs in `logs/runs.jsonl`                        | Every run has one id across model, tool and cost lines        | `python logs/show_run.py run-42`          | traces-and-cost.txt | no cost per branch yet                       |
| `release-gate`    | `gate.py` runs ten fixed orders before a release | A release is blocked when a fixed order gets a wrong answer   | `python gate.py`                          | release-gate.txt    | none                                         |

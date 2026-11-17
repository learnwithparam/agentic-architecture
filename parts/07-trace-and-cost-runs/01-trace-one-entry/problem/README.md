# Trace one entry

## The problem

The Holds team asks why one entry took so long. Finance asks what it cost. Today, each call writes its own log line. Nothing ties
the lines together. So you cannot see one entry from start to end, or the importer it ran for.

```mermaid
flowchart TD
  R[invoke_agent: tenant, team, run_id] --> T1[execute_tool read_shipment: allow]
  R --> T2[execute_tool lookup_tariff: allow]
  R --> M[chat smart: input and output tokens]
  R --> T3[execute_tool propose_code: allow]
  R --> T4[execute_tool file_entry: denied]
```

## Watch it done

Run `bun run verify trace-one-entry` on the starter, and see it fail. Then run it again with `solution` at the end, and see it
pass.

## Your turn

`entry.ts` runs one entry for the Classification agent. It makes a span for each call. A **span** is one timed piece of work,
such as one model call. A **trace** is all the spans of one run, in a tree.

`tracing.ts` is a small tracing library. You do not need to change it. Change `entry.ts`:

1. Put `tenant`, `team` and `run_id` in the run span's `baggage`. Baggage is copied to every child span.
2. Pass the parent span to `startSpan`, so each span joins the run's trace.
3. On model spans, set `gen_ai.request.model` and the token counts: `gen_ai.usage.input_tokens` and
   `gen_ai.usage.output_tokens`.
4. On tool spans, set `gen_ai.tool.name` and `policy.decision`. Do not copy the tool's input or output into the span.

For example, the check runs your entry for HG-1049, and expects 9 spans under one root. The `read_shipment` answer holds invoice
prices. So it must stay out of the trace.

Run the check from the repo root. Then go into this folder to print the trace:

```bash
bun run verify trace-one-entry
cd parts/07-trace-and-cost-runs/01-trace-one-entry/problem
bun show-trace.ts
cd ../../../..
```

Expect: `Done. All 6 rules pass.`, then `9 spans, 1 root(s):` and the tree.

![The check passing and the trace of HG-1049](../images/expected.png)

## Do it on your work

Pick one finished job of yours. Follow it from the first request to the last result, and list each hop. Use your own files. A good
answer gives proof for each line below.

## Done when

- Your entry runs to the end, and sends its spans to the trace store.
- All the spans form one trace, with one root span.
- Every span carries `tenant`, `team` and `run_id`.
- Model spans name the role, and their tokens add up to the gateway's spend log.
- There is one tool span per tool call, with the tool's name and the policy decision.
- No span holds invoice text, prices, team keys or tokens.

## Solution

The after state is in `solution/`. Compare it with `diff -r problem/ solution/`.

## If you get stuck

| What you see                          | Fix                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `FAIL all the spans form one trace`   | Change `startSpan(name, undefined, ...)` to `startSpan(name, parent, ...)`. |
| `FAIL every span carries tenant ...`  | Set `run.baggage`, not `run.attributes`. Attributes stay on one span.       |
| `FAIL no span holds invoice text ...` | Remove `tool.input` and `tool.output`.                                      |

## Words you will use

- **Span**: one timed piece of work, with a name and attributes.
- **Trace**: every span of one run, linked from child to parent, under one root.
- **Attribute**: a name and a value on a span, such as `gen_ai.tool.name=lookup_tariff`.
- **Baggage**: values a parent passes to every child span, such as the importer.
- **Tenant**: the customer the work is for. Here, the importer.

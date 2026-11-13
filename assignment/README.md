# Assignment: move the resume layer onto Temporal

Optional in the live session. Expected as homework.

## Task

Move the resume layer onto Temporal without changing the other six layers.
Work in `assignment/starter/` (the same folder as the step's `problem/`). It has `worker.ts` and `start.ts` done, and two activity stubs.
Start the server with `docker compose -f assignment/compose.yml up -d --wait`.
Fill in `activities.ts` and `workflow.ts`, using the course's own tool calls from the survive-a-crash part.
Also write `CHOICE.md`: one short paragraph on when DBOS would fit better than Temporal.

## Check it

```bash
bun run assignment
```

Expect: `Done. All 6 rules pass.` and `assignment/result.json` with each line set to `pass`.

Stop the server when you are done.

```bash
docker compose -f assignment/compose.yml down -v
```

Expect: the container and its network are removed.

## Done when

- `@temporalio/client` resolves to 1.25.0.
- The workflow reaches Completed after the scripted worker kill.
- Each activity has exactly one completed event in the history.
- The course's existing checks still pass.

The script also checks that the worker really died and that the exam was booked and paid once.

## Rubric (a person reads this)

- The activities are the course's own steps, not new code.
- No layer outside resume changed.
- `CHOICE.md` says when DBOS fits better.

## Submit

Push a branch named `assignment` and submit its URL. The grader runs `bun run assignment` again.

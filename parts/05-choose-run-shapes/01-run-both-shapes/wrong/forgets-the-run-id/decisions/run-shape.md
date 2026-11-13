# Run shape for each team

## Shape

- Classification: a workflow.
- Paperwork: a workflow with one model step, until it needs to talk to importers.
- Holds: an agent loop with a step limit of 8.

## Why

Classification does the same three moves for every invoice line.
Code can write that path down, and the model only picks the code.
For example, shipment HG-1049 has 2 lines, so its run asks the model 2 times.

Holds cannot know its path in advance.
Customs may refuse a booking, or the fee may change.
So the model picks the next action each turn.
The step limit stops a run that makes no progress, like a booking that fails every time.

Paperwork drafts the entry in a fixed order today, so a workflow is enough.

## What would change it

- If Holds always took the same three actions, we would make it a workflow. It would cost fewer model calls.
- If Paperwork started to email importers and wait for replies, it would need an agent loop.
- If a run hit its step limit often, we would look at the trace before we raised the limit.

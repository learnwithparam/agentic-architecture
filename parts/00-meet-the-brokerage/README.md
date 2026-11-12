# Meet the brokerage

## The problem

Three teams at Harbourgate Brokerage run three agents, built three ways. Each pastes its own provider
key, calls tools with no identity, and reads any importer's papers. Two entries went to customs with no
broker signature, and one exam fee was paid twice after a crash. This part measures that, so every later
part has a number to drive to zero.

```mermaid
flowchart LR
  subgraph Now[As it is]
    C1[Classification script] --> PA[Provider a]
    P1[Paperwork script] --> PA
    H1[Holds script] --> PA
    C1 & P1 & H1 --> W[(Customs, documents, payments)]
  end
  subgraph Platform[On the platform]
    C2[Classification] & P2[Paperwork] & H2[Holds] --> GW[Model gateway] --> PB[Providers]
    C2 & P2 & H2 --> TG[Tool gateway: identity, policy, tenant] --> W2[(Customs, documents, payments)]
  end
```

| Step                 | Minutes | What you produce                                                      |
| -------------------- | ------- | --------------------------------------------------------------------- |
| `meet-the-brokerage` | 20      | `platform.toml` with your name, run mode and the six "before" numbers |

## Walkthrough

```bash
bun run world
bun run before
bun run after
bun run verify meet-the-brokerage
```

Expect: the open queue of 12 shipments, the "before" card, the "after" card with six zeros, then `Done. All 10 rules pass.` once `platform.toml` is filled in.

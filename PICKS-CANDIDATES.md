# Picks candidates (the page pass cuts to 4 to 6 per part, then deletes this file)

How to read this file. Each row is a candidate for the "Watch and read" list of one part.
The bar is section 5 of STANDARD-v2.
A pick is made by the person or team who made the method or runs it in production.
It is about the idea and not a product launch.
It is never a listicle, SEO site, content farm or paywall.
Kind is `read` or `video`. Each part has at least two videos, so the cut can keep two.

Honest limit: the build run could not open these pages. Authors, years and titles come from memory.
Rows marked `verify` are the ones least sure, so check the exact title and year first.
The page pass must run the nightly link check (YouTube through oEmbed) before any row is kept.

## 00 meet-the-brokerage

| Kind  | Author and year                                | Title                                            | Why it passes the bar                                                      |
| ----- | ---------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| read  | Erik Schluntz and Barry Zhang, Anthropic, 2024 | Building effective agents                        | The team that runs agents in production; about patterns, not a launch.     |
| video | Barry Zhang, Anthropic, 2025 (verify)          | How we build effective agents (AI Engineer talk) | Same authors, a major conference talk, and short.                          |
| read  | Anthropic engineering, 2025                    | How we built our multi-agent research system     | Written by the team that built and runs it; honest about cost and failure. |
| read  | Anthropic engineering, 2025                    | Writing effective tools for agents               | The tool makers explain tool design; evergreen.                            |
| read  | OpenAI, 2025                                   | A practical guide to building agents             | The vendor's own guide, about design and guardrails.                       |
| read  | Grab Engineering, 2025 (verify)                | How Grab builds and runs AI agents at scale      | A company that runs the shared platform; already cited in the root README. |
| read  | Lilian Weng, 2023                              | LLM Powered Autonomous Agents                    | A researcher at OpenAI at the time; the standard overview, about the idea. |
| read  | Walden Yan, Cognition, 2025                    | Don't build multi-agents                         | A team that runs a coding agent in production argues one side with cases.  |
| video | Andrew Ng, DeepLearning.AI, 2024 (verify)      | Agentic design patterns talk                     | A named expert at a major conference; about patterns, not products.        |

## 01 route-model-calls

| Kind  | Author and year                       | Title                                                                | Why it passes the bar                                            |
| ----- | ------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| read  | Marc Brooker, AWS, 2019               | Timeouts, retries and backoff with jitter (Amazon Builders' Library) | Written by the engineer who runs these systems; evergreen.       |
| read  | Google SRE, 2016                      | Handling overload (SRE book, chapter 21)                             | The team that runs the service; about the idea of shedding load. |
| read  | Google SRE, 2016                      | Addressing cascading failures (SRE book)                             | Same team; explains why fallbacks can make an outage worse.      |
| read  | Paul Tarjan, Stripe, 2017             | Scaling your API with rate limiters                                  | A production team explains four limiters with real traffic.      |
| read  | Cloudflare, docs (verify year)        | AI Gateway: caching and rate limiting                                | The vendor that runs the gateway; short, about the ideas.        |
| read  | Uber Engineering, 2025 (verify)       | Uber's GenAI gateway for model access                                | A company that runs one in production.                           |
| read  | Anthropic, docs                       | Rate limits and prompt caching                                       | The provider's own rules, so a gateway can match them.           |
| read  | BerriAI, docs                         | LiteLLM proxy: routing, fallbacks, budgets                           | The makers of a widely used gateway, about the same features.    |
| video | Marc Brooker, AWS re:Invent (verify)  | A talk on retries, timeouts and load shedding                        | A named engineer at a major conference.                          |
| video | Envoy maintainers, CNCF talk (verify) | Global rate limiting with Envoy                                      | The project's own maintainers; about the idea.                   |

## 02 police-tool-calls

| Kind  | Author and year                                          | Title                                              | Why it passes the bar                                                                     |
| ----- | -------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| read  | DoorDash Engineering, 2025 (verify)                      | How DoorDash built a gateway for agent tool access | Runs it in production; already cited in this part.                                        |
| read  | Uber Engineering, 2025 (verify)                          | Designing an MCP gateway                           | Runs it in production; already cited in this part.                                        |
| read  | Model Context Protocol maintainers, 2025                 | MCP specification: authorization                   | The authors of the standard; the base for the OAuth step.                                 |
| read  | IETF, 2025                                               | RFC 9728, OAuth protected resource metadata        | The original standard behind the metadata path.                                           |
| read  | Simon Willison, 2025                                     | The lethal trifecta for AI agents                  | A well-known practitioner with working cases; about the idea. (verify bar: personal blog) |
| read  | OWASP GenAI project, 2025                                | Top 10 for LLM applications: prompt injection      | The community standard body; evergreen as a list of risks.                                |
| read  | Google DeepMind, 2025                                    | CaMeL: defeating prompt injections by design       | The original paper from the team that made the method.                                    |
| read  | Meta, 2025 (verify)                                      | Agents Rule of Two                                 | The company's own security rule for agents.                                               |
| read  | Rebedea et al., NVIDIA, 2023                             | NeMo Guardrails                                    | The original paper from the team that built the toolkit.                                  |
| video | Anthropic or Meta security speaker, AI Engineer (verify) | A talk on prompt injection defences                | A major conference; choose the one by the team that runs the defence.                     |
| video | Invariant Labs, 2025 (verify)                            | Tool poisoning in MCP, demo                        | A security team that found the attack and shows it.                                       |

## 03 identify-each-agent

| Kind  | Author and year                        | Title                                             | Why it passes the bar                                                   |
| ----- | -------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| read  | IETF, 2020                             | RFC 8693, OAuth 2.0 token exchange                | The original standard for the exchange step, including the `act` claim. |
| read  | Norm Hardy, 1988                       | The confused deputy                               | The original paper behind the delegation rules.                         |
| read  | SPIFFE project, CNCF, docs             | SPIFFE concepts                                   | The makers of the workload identity standard.                           |
| read  | Google, 2014                           | BeyondCorp: a new approach to enterprise security | The company that runs it; about the idea.                               |
| read  | Google and Linux Foundation, 2025      | Agent2Agent (A2A) protocol specification          | The authors of the standard for agent to agent calls.                   |
| read  | MCP maintainers, 2025                  | MCP authorization specification                   | The authors; ties tokens to tools.                                      |
| read  | IETF, 2023                             | RFC 9449, DPoP                                    | The standard for tokens bound to a sender.                              |
| read  | AWS, docs (verify)                     | Bedrock AgentCore Identity                        | A vendor that runs it; use as a contrast to the course build.           |
| video | Aaron Parecki, Okta, 2020s (verify)    | OAuth 2.0 and OIDC in plain English               | A co-author of the OAuth specs; a conference talk.                      |
| video | SPIFFE maintainers, CNCF talk (verify) | Workload identity at scale                        | The project's own maintainers.                                          |

## 04 separate-importer-data

| Kind  | Author and year                                       | Title                                                          | Why it passes the bar                                  |
| ----- | ----------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| read  | PostgreSQL project, docs                              | Row security policies                                          | The makers; the page the step relies on.               |
| read  | AWS, 2020 (verify)                                    | Multi-tenant data isolation with PostgreSQL row level security | A team that runs SaaS tenancy at scale.                |
| read  | Notion engineering, 2021                              | Herding elephants: sharding Postgres at Notion                 | A company that runs it; shows tenant keys in practice. |
| read  | Figma engineering, 2024 (verify)                      | How Figma scaled its databases                                 | A production team; evergreen lessons on tenant keys.   |
| read  | Pinecone, docs                                        | Multitenancy with namespaces                                   | The makers of the vector store, about the idea.        |
| read  | Packer et al., UC Berkeley, 2023                      | MemGPT: towards LLMs as operating systems                      | The original paper behind agent memory.                |
| read  | Chhikara et al., Mem0, 2025 (verify)                  | Mem0: production-ready agents with long-term memory            | The team that built it, with measured results.         |
| read  | Anthropic, docs, 2025                                 | Memory tool                                                    | The vendor's own design for scoped memory.             |
| video | Supabase team, 2022 (verify)                          | Row level security explained                                   | The makers show it live.                               |
| video | Postgres conference speaker (PGCon or PGConf, verify) | Row level security deep dive                                   | A named talk at a major conference.                    |

## 05 choose-run-shapes

| Kind  | Author and year                                     | Title                                            | Why it passes the bar                        |
| ----- | --------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| read  | Anthropic, 2024                                     | Building effective agents (workflows and agents) | The source of the two shapes in this part.   |
| read  | Yao et al., Princeton and Google, 2022              | ReAct: synergizing reasoning and acting          | The original paper for the loop shape.       |
| read  | LangChain, docs                                     | Workflows and agents (LangGraph)                 | The makers show both shapes in code.         |
| read  | Microsoft, Azure Architecture Center, 2025 (verify) | AI agent orchestration patterns                  | A vendor reference that compares patterns.   |
| read  | Google Cloud, 2025 (verify)                         | Choose a design pattern for an agentic system    | A vendor reference with trade-offs.          |
| read  | Cognition, 2025                                     | Don't build multi-agents                         | Production view on shared context.           |
| read  | Anthropic engineering, 2025                         | How we built our multi-agent research system     | Shows a loop with sub-agents and its cost.   |
| video | Barry Zhang, Anthropic, 2025 (verify)               | How we build effective agents                    | A short conference talk on the same choice.  |
| video | Harrison Chase, LangChain, 2025 (verify)            | A talk on agent architectures                    | The maker of the framework, at a conference. |

## 06 survive-a-crash

| Kind  | Author and year                                              | Title                                                 | Why it passes the bar                                   |
| ----- | ------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| read  | Brandur Leach, Stripe, 2017                                  | Implementing Stripe-like idempotency keys in Postgres | A production engineer shows the exact pattern.          |
| read  | Stripe, docs                                                 | Idempotent requests                                   | The company that runs it.                               |
| read  | Malcolm Featonby, AWS, 2019                                  | Making retries safe with idempotent APIs              | Amazon Builders' Library; about the idea.               |
| read  | Pat Helland, 2012                                            | Idempotence is not a medical condition                | A veteran engineer, in ACM Queue; evergreen.            |
| read  | Garcia-Molina and Salem, 1987                                | Sagas                                                 | The original paper for undoing steps in a long run.     |
| read  | Temporal, docs                                               | What is durable execution                             | The makers; shows replay of a killed worker.            |
| read  | Restate, docs and blog                                       | Durable execution, explained                          | The makers of a rival engine; a fair contrast. (verify) |
| read  | Chris Richardson, microservices.io                           | Pattern: saga                                         | A named author of a standard pattern catalogue.         |
| video | Maxim Fateev, Temporal, Replay talks (verify)                | Durable execution talk                                | The co-creator at the project's own conference.         |
| video | Brandur Leach or a Stripe engineer, conference talk (verify) | Idempotency and reliable payments                     | A production team at a conference.                      |

## 07 trace-and-cost-runs

| Kind  | Author and year                                                       | Title                                                            | Why it passes the bar                                         |
| ----- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| read  | OpenTelemetry project, CNCF, docs                                     | Semantic conventions for generative AI                           | The makers of the standard; names the fields to record.       |
| read  | Sigelman et al., Google, 2010                                         | Dapper, a large-scale distributed tracing infrastructure         | The original paper on traces.                                 |
| read  | Google SRE, 2016                                                      | Monitoring distributed systems (SRE book)                        | The team that runs it; evergreen.                             |
| read  | Phillip Carter, Honeycomb, 2023                                       | All the hard stuff nobody talks about when building LLM products | A production team shares real lessons on logging and tracing. |
| read  | FinOps Foundation, 2024 (verify)                                      | FinOps for AI                                                    | The standards body for cost allocation and tags.              |
| read  | Anthropic engineering, 2025                                           | How we built our multi-agent research system                     | Has a section on tracing agent runs.                          |
| read  | Langfuse, docs                                                        | Tracing and cost tracking                                        | The makers; shows tenant tags. (verify bar: vendor docs only) |
| read  | Uber Engineering, 2025 (verify)                                       | GenAI gateway cost attribution                                   | A production team shows spend by caller.                      |
| video | Liz Fong-Jones or Charity Majors, Honeycomb, conference talk (verify) | Observability for production systems                             | Named practitioners at major conferences.                     |
| video | OpenTelemetry maintainers, KubeCon talk (verify)                      | Tracing LLM applications                                         | The project's own maintainers.                                |

## 08 gate-each-release

| Kind  | Author and year                                              | Title                                           | Why it passes the bar                                                  |
| ----- | ------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------- |
| read  | Hamel Husain, 2024                                           | Your AI product needs evals                     | A practitioner with production clients; evergreen method. (verify bar) |
| read  | Anthropic, docs                                              | Define success criteria and build evaluations   | The vendor's own method.                                               |
| read  | OpenAI, docs                                                 | Evals guide                                     | The vendor's own method.                                               |
| read  | Google SRE, 2018                                             | Canarying releases (SRE Workbook)               | The team that runs it; about the idea.                                 |
| read  | Google SRE, 2016                                             | Release engineering (SRE book)                  | Same team; evergreen.                                                  |
| read  | Netflix Technology Blog, 2018                                | Automated canary analysis at Netflix (Kayenta)  | A company that runs it.                                                |
| read  | Eugene Yan, 2024 (verify)                                    | Task-specific LLM evals that do and do not work | A practitioner at a major company; about the idea. (verify bar)        |
| read  | Anthropic engineering, 2025 (verify)                         | Writing about evals for agents                  | The team that runs agents; check the exact title.                      |
| video | Jez Humble or Dave Farley, continuous delivery talk (verify) | Deployment pipelines                            | The people who defined the method.                                     |
| video | Hamel Husain and Shreya Shankar, evals course talk (verify)  | Evals for AI products                           | Named practitioners; check it is free.                                 |

## 09 swap-and-review

| Kind  | Author and year                                               | Title                                               | Why it passes the bar                                      |
| ----- | ------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| read  | Michael Nygard, Cognitect, 2011                               | Documenting architecture decisions                  | The original post for decision records.                    |
| read  | AWS, docs                                                     | Well-Architected Framework: review process          | The company that runs reviews with customers.              |
| read  | CNCF TAG App Delivery, 2023                                   | Platforms white paper                               | A standards group; about the idea of a platform.           |
| read  | Spotify Engineering, 2020                                     | How we use golden paths to solve fragmentation      | A company that runs a platform.                            |
| read  | Grab Engineering, 2025 (verify)                               | How Grab builds and runs AI agents at scale         | A shared platform that onboards teams; cited in this part. |
| read  | Gregor Hohpe, 2020                                            | The Architect Elevator (selected chapters or posts) | A named architect; evergreen. (verify bar: book excerpt)   |
| read  | BerriAI, docs                                                 | LiteLLM proxy overview                              | The product used in the swap step.                         |
| read  | Thoughtworks, Technology Radar (verify)                       | Platform engineering and AI entries                 | A company that publishes a regular review.                 |
| video | Matthew Skelton or Manuel Pais, Team Topologies talk (verify) | Platform as a product                               | The authors of the method at a conference.                 |
| video | A platform team talk at PlatformCon (verify)                  | Onboarding a new team with no code change           | A practitioner talk; choose one by a company that runs it. |

## 10 make-the-resume-survive-a-crash-with-temporal

| Kind  | Author and year                                        | Title                                                | Why it passes the bar                               |
| ----- | ------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| read  | Temporal, docs                                         | Workflows and determinism                            | The makers; needed to read the history in the step. |
| read  | Temporal, docs                                         | TypeScript SDK developer guide                       | The makers; the exact API used.                     |
| read  | Temporal, docs                                         | Event history                                        | The makers; explains what the check reads.          |
| read  | Temporal blog, 2023 (verify)                           | Saga pattern made easy                               | The makers show compensation.                       |
| read  | Uber Engineering, 2019 (verify)                        | Cadence: the workflow engine that Temporal grew from | A company that runs it.                             |
| read  | Temporal, 2025 (verify)                                | Durable agents with the OpenAI Agents SDK            | The makers show it for agents.                      |
| read  | Pat Helland, 2012                                      | Idempotence is not a medical condition               | Why a replayed activity must be safe.               |
| video | Maxim Fateev, Temporal, Replay (verify)                | Designing a workflow engine from first principles    | The co-creator.                                     |
| video | Temporal, Replay conference talk on AI agents (verify) | Durable execution for agents                         | The makers at their own conference.                 |

## 11 decide-tool-calls-with-cedar

| Kind  | Author and year                                      | Title                                                                          | Why it passes the bar                                    |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| read  | Cutler et al., Amazon, 2024                          | Cedar: a new language for expressive, fast, safe, and analyzable authorization | The original paper from the team that made it.           |
| read  | Cedar project, docs                                  | Cedar policy language reference                                                | The makers; the syntax the step uses.                    |
| read  | AWS Open Source blog, 2023                           | Introducing Cedar                                                              | The makers explain the idea.                             |
| read  | Amazon Science, 2024 (verify)                        | How we built Cedar with verification-guided development                        | The makers explain how it is proven.                     |
| read  | Pang et al., Google, 2019                            | Zanzibar: Google's consistent, global authorization system                     | The original paper; the idea behind relationship checks. |
| read  | Open Policy Agent, CNCF, docs                        | Policy language and philosophy                                                 | The makers of a rival; a fair contrast.                  |
| read  | NIST, 2014                                           | SP 800-162, Guide to attribute based access control                            | A standards body; evergreen.                             |
| video | Cedar team at AWS, re:Inforce or re:Invent (verify)  | Cedar for authorization                                                        | The makers at a major conference.                        |
| video | Open Policy Agent maintainers, KubeCon talk (verify) | Policy as code with OPA                                                        | The project's own maintainers.                           |

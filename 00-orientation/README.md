# Start here

On this page you set up the repo and meet Harbourgate Brokerage.
Then you run the finished platform and see where the course ends.

You do not need a model key.
The models answer from replies we recorded earlier.
We call this replay mode.

## Set up

You need [Bun](https://bun.sh) 1.4.4 or newer, and git.
You do not need Docker or a cloud account.

```bash
bun install
bun run models
```

Expect: three `PASS` lines, one for each role (`fast`, `smart`, `judge`), on provider `replay`.

Later, you can use a real model provider.
Copy `.env.example` to `.env`, then set `LLM_PROVIDER` and that provider's key.
Run `bun run models` again to test it.
The checks never need a key.

## Meet the world

Harbourgate Brokerage is a customs broker at the Port of Saltmere.
A customs broker fills in the forms that let goods into a country.
Each form is a customs entry.

Harbourgate files entries for three importers:

- Fjordline Outdoor brings in jackets, tents and sleeping bags.
- Ridgeway Roasters brings in green coffee beans.
- Northpoint Medical Supply brings in gloves and thermometers.

Three teams inside Harbourgate each run an agent.
An agent is a program that asks an AI model what to do next, then does it.

| Team           | Its agent                                               | What it may do                            |
| -------------- | ------------------------------------------------------- | ----------------------------------------- |
| Classification | Proposes a tariff code for each invoice line            | Read tariff data and propose. Never file. |
| Paperwork      | Drafts the entry, asks for missing papers, files        | File only lines a licensed broker signed  |
| Holds          | Books the customs exam, pays the fee, waits for release | Pay each fee once                         |

This world has one legal rule: a licensed broker signs every tariff code before an entry is filed.
A tariff code says what the goods are, so customs knows the tax.
For example, a line of Ridgeway's green coffee gets a tariff code from Classification.
Then a broker signs it. Only then may Paperwork file the entry.

```bash
bun run world reset
bun run world
```

Expect: `World reset: 60 shipments, 12 open`, then the importers, the teams and the 12 open shipments.

## Run the system as it is, then the finished platform

First you see Harbourgate as it works today. Then you see the platform you will build.

```bash
bun run before
bun run after
```

Expect: the "before" card shows `41` model calls that bypassed the gateway and `2` entries filed with no broker signature; the "after" card shows `0` on every line and a cost per released entry for each importer.

![The finished platform: every count at zero and a cost per released entry](images/after.png)

## See the goal

At the end of the course, you point `bun run before` at your own platform.
It prints the "after" card, with every count at zero.
Each part builds one layer, and a check proves it works.

Your first step records today's numbers:
[meet-the-brokerage](../parts/00-meet-the-brokerage/01-meet-the-brokerage/problem/README.md).

```bash
bun run verify meet-the-brokerage
```

Expect: `FAIL` lines, each with a `Try next:` line. Every step starts failing; that is the starting point.

Does a command print something you do not expect? Look it up in [troubleshooting.md](troubleshooting.md).

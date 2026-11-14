# Platform review

## Gateway

Every model call goes through one gateway. It caps spend per customer and falls back to a second provider when the first one is down.

## Tools

Agents may call only tools on a short approved list. Each tool was added after a review by the platform owner and is listed in a file.

## Identity

Each agent gets its own short lived token for every call. A call with no token or an old token is refused at the gateway.

## Data

Every row and every memory is tagged with a customer. A query without that tag returns nothing, and a test checks this on every table.

## Run shape

Quick questions run in one request. Long imports run as steps that save progress, so a killed run resumes where it stopped.

## Trace and cost

Every run writes one trace with a run id. A report adds up tokens per customer so we can see who costs what each day.

## Release

A new release runs a fixed set of checks first. If one fails, the release is blocked and the old version keeps running.

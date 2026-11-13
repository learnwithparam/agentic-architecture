# Swap: the model gateway onto LiteLLM

## What we swapped

The model gateway layer. LiteLLM now calls the providers and falls back from provider a to provider b.
Our adapter, `litellm-gateway.ts`, writes LiteLLM's config from `routes.json` and starts it.

## What stays the same

The contract. Teams still send their team key and `x-importer`.
They still get 401 for a bad key, 402 at a budget, and the `x-gateway-provider` header.
Every call still writes one spend row, and the spend log still equals the providers' bill.
Nothing under `teams/` changed.

## What we gained

- Retries and fallback are LiteLLM's code now, not ours. It knows many more providers than our two.
- Adding a provider is one entry in the config, not new code.

## What we lost

- We see failed tries only through LiteLLM's headers. If a header changes, our provider_error rows are wrong.
- One more process to run, update and patch. LiteLLM has had security advisories, so we must watch them.
- Startup is slower, because LiteLLM must start before the gateway answers.

## How we would undo it

Set `[gateway] start = "bun gateway.ts"` in `platform.toml` and remove `[swap]`.
Our own gateway still passes the same checks, so we can switch back in one line.

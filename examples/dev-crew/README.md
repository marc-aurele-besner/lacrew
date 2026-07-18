# Example: dev crew

Off-chain coding agents (PRs, reviews) with real onchain spend for compute, APIs, and contractor payouts.

## Shape

```
Human root
 └── Eng manager
 │      ├── Coder
 │      └── Reviewer
 └── Ops [API / compute spend]
```

## Run

```bash
pnpm --filter @lacrew/example-dev-crew start

# Against orchestrator MCP HTTP
ORCH_URL=http://127.0.0.1:8788 pnpm --filter @lacrew/example-dev-crew start
```

See [`policy.json`](./policy.json). The Ops spend prints a mocked **x402-style** payment receipt (held when escalated).

## Status

Runnable against mock SDK and orchestrator HTTP. Real x402 settlement still TODO.

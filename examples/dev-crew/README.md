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

## Live chain (Anvil)

```bash
anvil                                  # terminal A
lacrew deploy --anvil                  # terminal B (writes deployments)
lacrew epoch --rpc http://127.0.0.1:8545

ANVIL_RPC=http://127.0.0.1:8545 \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
MANAGER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
pnpm --filter @lacrew/example-dev-crew start
```

Session-signed proposes against the deployed org: under-cap spends execute
(ALLOW + tx hash), over-cap spends escalate with the approval dry-run attached,
and the manager key approves the first escalation onchain.

# Example: trading crew

Scanner → executor → risk-manager crew sharing a treasury with hard per-agent caps.

## Shape

```
Human root
 └── Risk manager  [approves escalations]
      ├── Scanner       [tiny allowance]
      └── Executor      [position-taking within cap]
```

**Latency boundary:** no MEV / HFT through onchain approval — escalations are human-timescale.

## Run (mock SDK)

```bash
pnpm --filter @lacrew/example-trading-crew start
```

Prints demo proposes + attached F1.16 simulations from `policy.json`.

## Run against a live orchestrator

```bash
pnpm --filter @lacrew/orchestrator dev   # :8788
ORCH_URL=http://127.0.0.1:8788 pnpm --filter @lacrew/example-trading-crew start
```

Uses `POST /mcp/call` (`lacrew_propose_intent`) then lists `/intents`.

## Policy config

See [`policy.json`](./policy.json) for org shape, spend caps, whitelist targets, and MCP tool list.

## Status

Runnable against mock SDK and orchestrator HTTP. Onchain Anvil wiring still uses DeployMockOrg addresses (not this JSON directly).

## Live chain (Anvil)

```bash
anvil                                  # terminal A
lacrew deploy --anvil                  # terminal B (writes deployments)
lacrew epoch --rpc http://127.0.0.1:8545

ANVIL_RPC=http://127.0.0.1:8545 \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
MANAGER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
pnpm --filter @lacrew/example-trading-crew start
```

Session-signed proposes against the deployed org: under-cap spends execute
(ALLOW + tx hash), over-cap spends escalate with the approval dry-run attached,
and the manager key approves the first escalation onchain.

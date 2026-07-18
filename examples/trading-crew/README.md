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

# LaCrew

**Protocol spec:** [SPEC.md](./SPEC.md) (v0.1 draft) — the normative interface surface, invariants, and conformance rules.

**Payroll, budgets, and approvals for AI agent teams.**

> Your agents. Their budgets. Your keys.

LaCrew is an open source protocol and platform for organizing AI agents the way you organize a company. Every agent is a node in an onchain org chart with its own smart account, a streaming allowance, and a policy that defines what it can do on its own.

## What's in this repo

| Path | Purpose |
| --- | --- |
| `contracts/` | Solidity contracts (Foundry): OrgRegistry, Treasury, EscalationRouter, GovernanceModule, PolicyModules |
| `packages/core` | Shared TypeScript types, ABIs, constants |
| `packages/sdk` | Typed client for org state, intents, escalations, sessions |
| `packages/db` | Drizzle + Postgres (Neon or Docker) |
| `packages/orchestrator` | Agent runtime: pg-boss queue, session keys, intent proposal |
| `packages/adapters/*` | Wallet and agent-framework adapters |
| `apps/cli` | Scaffold an org, run a crew locally, self-host |
| `apps/docs` | Protocol docs (docs.lacrew.xyz) |
| `examples/` | Starter crew templates |

The hosted cloud (`lacrew.xyz`) is a separate private repo. It depends on these packages; it does not fork them.

## Status

Phase 0 — scaffolding and spec. Contracts and packages contain mock / stub implementations marked clearly. Do not use with real funds.

## Quickstart

```bash
pnpm install
pnpm build

# Mock orchestrator only (no chain required) — http://127.0.0.1:8788
pnpm dev
```

### Optional Anvil loop (indexer / onchain SDK)

`pnpm dev` does **not** start a blockchain. For onchain escalate → approve (USDC spend):

```bash
# Terminal A — local chain
anvil

# Terminal B — deploy reference org (manager = Anvil account #1) + sync addresses
pnpm --filter @lacrew/cli exec tsx src/index.ts deploy --anvil

# Terminal C — orchestrator in onchain mode
# PRIVATE_KEY = Anvil #0 (deployer / propose)
# MANAGER_PRIVATE_KEY = Anvil #1 (resolve) — see .env.example
export ANVIL_RPC=http://127.0.0.1:8545 CHAIN_ID=31337
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export MANAGER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
pnpm --filter @lacrew/orchestrator dev
# POST http://127.0.0.1:8788/tick  → pending ESCALATE intent
# Approvals UI (lacrew.xyz) → Approve → USDC to x402Target

# Terminal D — event indexer (optional)
pnpm dev:indexer
```

Without `ANVIL_RPC` + `PRIVATE_KEY`, the orchestrator stays on the in-memory mock client.

See [apps/docs/content/self-host.md](./apps/docs/content/self-host.md) for the full loop.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

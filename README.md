# LaCrew

**Payroll, budgets, and approvals for AI agent teams.**

> Your agents. Their budgets. Your keys.

LaCrew is an open source protocol and platform for organizing AI agents the way you organize a company. Every agent is a node in an onchain org chart with its own smart account, a streaming allowance, and a policy that defines what it can do on its own.

## What's in this repo

| Path | Purpose |
| --- | --- |
| `contracts/` | Solidity contracts (Foundry): OrgRegistry, Treasury, EscalationRouter, GovernanceModule, PolicyModules |
| `packages/core` | Shared TypeScript types, ABIs, constants |
| `packages/sdk` | Typed client for org state, intents, escalations, sessions |
| `packages/orchestrator` | Agent runtime: scheduling, session keys, intent proposal |
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
```

See [AGENTS.md](./AGENTS.md) for monorepo conventions and commands.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

# Agent guidelines for lacrew

Open source core of [LaCrew](https://lacrew.xyz): onchain org chart, budgets, escalation, and governance for AI agent teams.

Sibling private repo: `lacrew.xyz` (hosted cloud). Anything users must trust to verify non-custody lives here. Convenience-only cloud plumbing stays private.

## Stack

| Layer | Tech |
| --- | --- |
| Contracts | Solidity 0.8.x, Foundry, OpenZeppelin, Base (Sepolia → mainnet) |
| Packages | TypeScript, pnpm workspaces, Turborepo |
| Chain | viem |
| Orchestrator | Node 22+, Hono/Fastify, BullMQ, Drizzle/Postgres |
| Docs | Fumadocs (planned) |

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Build all | `pnpm build` |
| Test (TS) | `pnpm test` |
| Contracts build | `cd contracts && forge build` |
| Contracts test | `cd contracts && forge test` |
| Format | `pnpm format` |

## Architecture (enforcement path)

1. **OrgRegistry** — tree of human roots, manager agents, worker agents.
2. **Treasury** — holds funds; streams allowances downward. Leaves never pull from treasury directly.
3. **IPolicyModule** — `check(agent, target, value, data) → ALLOW | ESCALATE | DENY`. Modules stack; first DENY wins; ESCALATE climbs the tree.
4. **EscalationRouter** — pending intents + parent approval / recurse.
5. **GovernanceModule** — constitutional actions only (hire/fire, budgets, policy upgrades). Low-tier: majority instant. High-tier: timelock + human veto.
6. **Orchestrator** (off-chain) — runs agents, proposes intents, holds only short-lived session keys.

Wallet infrastructure is wrapped via adapters (AgentKit, Safe, etc.), not reinvented.

## Repo layout rules

- Put shared types/ABIs in `@lacrew/core`.
- SDK and orchestrator consume `@lacrew/core`; cloud imports `@lacrew/sdk` and `@lacrew/orchestrator`.
- Adapters are separate packages under `packages/adapters/`.
- Comments on unfinished work must use `TODO:` and mark stubs with `Mocked` so they are greppable.

## Code conventions

- Comments describe current logic only — no "previously" / "instead of" history in comments.
- Prefer small, story-sized commits.
- Do not commit secrets, private keys, or funded mnemonic material.
- Mock data and stubs are fine in Phase 0; label them clearly.

## Security posture

Enforcement is onchain. The orchestrator must remain replaceable and non-custodial: session keys only, scoped and expiring. Never move root-key material into this repo or the cloud.

## Related docs

Product brief and engineering plan live in the parent workspace (`lacrew.md`). Protocol white paper content should land in `apps/docs` as it firms up.

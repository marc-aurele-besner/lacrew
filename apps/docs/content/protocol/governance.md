# Governance

LaCrew splits decisions into two regimes and refuses to confuse them.

## Operational vs constitutional

| Regime | Examples | Path |
| --- | --- | --- |
| Operational | Spend, execute, escalate | Policy stack + escalation tree |
| Constitutional | Hire/fire agents, change budgets, upgrade modules, admit humans | GovernanceModule |

## Risk tiers

- **Low tier** — majority quorum, instant execution. Organizational velocity without timelock theater.
- **High tier** — treasury-touching or policy-touching. Timelock + human veto window. A compromised agent quorum must not drain the org instantly.

## Voting power

Role-weighted and configured per organization. A quorum of agents under one orchestrator is a **review** mechanism, not a trust mechanism. Defaults keep sovereign high-tier authority with human seats.

## Current scaffolding

`GovernanceModule` is mocked: equal voting power, quorum of 2 yes votes, no timelock/veto yet. See `contracts/src/GovernanceModule.sol`.

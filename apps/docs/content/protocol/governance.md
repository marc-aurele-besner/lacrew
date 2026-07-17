# Governance

LaCrew splits decisions into two regimes and refuses to confuse them.

## Operational vs constitutional

| Regime | Examples | Path |
| --- | --- | --- |
| Operational | Spend, execute, escalate | Policy stack + escalation tree |
| Constitutional | Hire/fire agents, change budgets, upgrade modules, admit humans | GovernanceModule |

## Risk tiers

- **Low tier** — majority quorum, execute after quorum (no timelock).
- **High tier** — treasury-touching or policy-touching. Voting deadline + **1-day timelock** (`eta`); human root may **`veto`** before execute.

## Execution

Proposals bind `target` + `calldata`. On `execute`, the module calls `target.call(data)` after quorum (and high-tier eta). OrgRegistry / Treasury accept mutations from the governor address after bootstrap `setGovernor`.

## Voting power

Still scaffolding: every address = 1 vote, quorum = 2 yes. Role-weighted seats are TODO.

## Current scaffolding gaps

- No role-weighted voting
- Router / policy `setTreasury` / `setRateRecorder` still loosely gated
- Session-key / passkey root binding not onchain yet

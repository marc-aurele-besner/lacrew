# Governance

LaCrew splits decisions into two regimes and refuses to confuse them.

## Operational vs constitutional

| Regime | Examples | Path |
| --- | --- | --- |
| Operational | Spend, execute, escalate | Policy stack + escalation tree |
| Constitutional | Hire/fire agents, change budgets, upgrade modules, admit humans | GovernanceModule |

## Risk tiers

- **Low tier** — execute as soon as all-seat yes-weight meets the effective quorum (no timelock).
- **High tier** — treasury-touching or policy-touching. Voting deadline + timelock (`eta`, default 1 day); any funded human seat may **`veto`** before execute. When **all** human voting weight has voted yes, execution skips the timelock (`unanimityFastPath`, default on) — the delay protects humans who have not weighed in, and unanimity means there are none left.

## Execution

Proposals bind `target` + `calldata`. On `execute`, the module calls `target.call(data)` after quorum (and high-tier eta or human unanimity). OrgRegistry / Treasury accept mutations from the governor address after bootstrap `setGovernor`. Proposals may target the GovernanceModule itself to retune quorums, weights, or timing — but only at High tier, so agent seats can never re-weight the electorate through a low-tier vote.

## Voting power

Seats are role-weighted (`votingPower` + `seatRole`): humans decide high-tier final say; agent yes-weight counts for low tier only. The root is seeded as a human seat at deploy (default weight 2 vs agent weight 1), so a founder outweighs any single agent seat from block one.

**Bootstrap safety:** the quorum `execute()` enforces is the configured value clamped to the seated weight (`effectiveQuorumYes` / `effectiveQuorumHumanYes`). A solo founder is never deadlocked behind a quorum sized for seats that do not exist yet; seating more weight restores the configured bar automatically.

## Configuration

All parameters are onchain and adjustable by the root directly or via a High-tier proposal targeting the module:

| Parameter | Default | Setter |
| --- | --- | --- |
| `quorumYes` (low tier, all seats) | 2 | `setQuorumYes` |
| `quorumHumanYes` (high tier, human seats) | 1 | `setQuorumHumanYes` |
| `votingPeriod` | 3 days (bounds 1h–30d) | `setTiming` |
| `highTierTimelock` | 1 day (bounds 0–30d) | `setTiming` |
| `unanimityFastPath` | on | `setUnanimityFastPath` |
| Seat weight / role | root: 2 human (constructor `rootPower_`) | `setVotingPower` |

## Current scaffolding gaps

- Session-key / passkey root binding not onchain yet
- Epoch streaming is on-demand (`runNextEpoch` / `POST /epoch`); `QueueProvider` + pg-boss can schedule epochs when `DATABASE_URL` is set

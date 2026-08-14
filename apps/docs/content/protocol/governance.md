---
title: "Governance"
---

LaCrew splits decisions into two regimes and refuses to confuse them.

## Operational vs constitutional

| Regime         | Examples                                                        | Path                           |
| -------------- | --------------------------------------------------------------- | ------------------------------ |
| Operational    | Spend, execute, escalate                                        | Policy stack + escalation tree |
| Constitutional | Hire/fire agents, change budgets, upgrade modules, admit humans | GovernanceModule               |

## Risk tiers

- **Low tier** — execute as soon as all-seat yes-weight meets the effective quorum (no timelock).
- **High tier** — treasury-touching or policy-touching. Voting deadline + timelock (`eta`, default 1 day); any funded human seat may **`veto`** before execute. When **all** human voting weight has voted yes, execution skips the timelock (`unanimityFastPath`, default on) — the delay protects humans who have not weighed in, and unanimity means there are none left.

## Execution

Proposals bind `target` + `calldata`. On `execute`, the module calls `target.call(data)` after quorum (and high-tier eta or human unanimity). OrgRegistry / Treasury accept mutations from the governor address after bootstrap `setGovernor`. Proposals may target the GovernanceModule itself to retune quorums, weights, or timing — but only at High tier, so agent seats can never re-weight the electorate through a low-tier vote.

## Voting power

Seats are role-weighted (`votingPower` + `seatRole`): humans decide high-tier final say; agent yes-weight counts for low tier only. The root is seeded as a human seat at deploy (default weight 2 vs agent weight 1), so a founder outweighs any single agent seat from block one.

**Bootstrap safety:** the quorum `execute()` enforces is the configured value clamped to the seated weight (`effectiveQuorumYes` / `effectiveQuorumHumanYes`). A solo founder is never deadlocked behind a quorum sized for seats that do not exist yet; seating more weight restores the configured bar automatically.

## More than one human

An org can seat any number of humans — agency partners, a club, a community-funded crew — and the roster is itself constitutional:

| Call                                  | Who may make it                              | Tier          |
| ------------------------------------- | -------------------------------------------- | ------------- |
| `setVotingPower(voter, power, Agent)` | The root address, directly                   | —             |
| `admitHuman(human, power)`            | The module itself, i.e. an executed proposal | High (forced) |
| `removeHuman(human)`                  | The module itself                            | High (forced) |

There is no key that can hand out a human seat. `admitHuman` / `removeHuman` — and any `setVotingPower` touching a `Human` seat — accept only the module as caller, and `propose` forces High tier on anything aimed at the module, so admitting a partner passes the humans already seated and any one of them can veto it. `humanSeatCount` reports the head count (weight answers a different question).

**The last human seat cannot be revoked** (`LastHumanSeat`) — not by `removeHuman`, not by demoting it to an agent seat. Agent yes-weight never satisfies high tier, so an org with no human left would be frozen rather than agent-run.

Veto is shared, not delegated: every funded human seat holds it outright, with no quorum and no delay. The root's _extra_ privileges (quorums, timing, agent seats) hold only while it still holds a human seat of its own — revoke the seat and the address is a stranger to the module. The one carve-out is a module deployed with `rootPower_ = 0`: while `humanSeatCount` is zero, the root may seat the first human directly, and the carve-out closes behind it.

A seat with power 0 is a revoked seat, not an observer — `vote()` reverts `NoVotingPower`, and veto rights derive from funded human seats. Watching without voting is a workspace concern, not a chain one.

In the tree, extra humans are `HumanRoot` nodes parented to the org's single root node (one tree, not a forest). The node draws the chart; the seat carries the authority. See [SPEC §3.1 / §6.1](../spec.md) and [Security model](./security.md) for what a compromise of one human out of two actually costs.

## Configuration

All parameters are onchain. Everything above the seat rows is adjustable by the root directly (while it holds a human seat) or via a High-tier proposal targeting the module; the human roster is governance-only:

| Parameter                                 | Default                                  | Setter                                         |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `quorumYes` (low tier, all seats)         | 2                                        | `setQuorumYes`                                 |
| `quorumHumanYes` (high tier, human seats) | 1                                        | `setQuorumHumanYes`                            |
| `votingPeriod`                            | 3 days (bounds 1h–30d)                   | `setTiming`                                    |
| `highTierTimelock`                        | 1 day (bounds 0–30d)                     | `setTiming`                                    |
| `unanimityFastPath`                       | on                                       | `setUnanimityFastPath`                         |
| Agent seat weight                         | manager: 1 agent (deploy script)         | `setVotingPower`                               |
| Human seat weight / roster                | root: 2 human (constructor `rootPower_`) | `admitHuman` / `removeHuman` (governance only) |

## Current scaffolding gaps

- Session-key / passkey root binding not onchain yet
- Epoch streaming is on-demand (`runNextEpoch` / `POST /epoch`); `QueueProvider` + pg-boss can schedule epochs when `DATABASE_URL` is set

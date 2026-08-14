---
title: "Plan-required mode"
---

An agent can already post a `plan` into its crew's thread — a sentence saying
what it is about to do, in the one window where a human can still redirect it.
Nothing makes it. A flow can merge a pull request, publish a post or propose a
spend with an empty thread behind it, and the operator's first sight of the work
is the audit row afterwards.

Plan-required mode closes that gap:

> **No plan, no side effect.**

With the mode on, a side-effecting step refuses unless the acting agent has
already said, on the record, what it intends.

## What it is not

**It is not approval.** A plan is a claim. Posting one admits nothing: the spend
still meets the policy stack, still escalates, and still waits for whoever
approves it. If the policy stack says DENY, a beautifully written plan changes
nothing. The mode bounds _when_ a crew may act, never _what_ it may do.

**It is not a human gate.** A [blocking human gate](./flows.md) stops the run
until a person picks an option. Plan-required asks nobody — the agent states its
intent and proceeds. They compose: a crew can require a plan _and_ gate the
merge behind a human.

**It is not onchain escalation.** ESCALATE routes an intent up the reporting
line to someone with the authority to approve it, and that is enforcement, on
chain. This is an off-chain supervision control that refuses to _start_ work.

Three different questions, and it is worth keeping them apart:

| Control                                   | Question it answers                        | Who decides                | Where        |
| ----------------------------------------- | ------------------------------------------ | -------------------------- | ------------ |
| Plan-required (F2.31)                     | did the agent say what it was about to do? | the agent itself           | orchestrator |
| [Dual control](./dual-control.md) (F2.32) | does a second seat agree with this effect? | another agent, or a person | orchestrator |
| Human gate (F2.27)                        | does a person agree, right now?            | a human seat               | orchestrator |
| Escalation (`ESCALATE`)                   | is this spend admitted, and by whom?       | the org chart + policy     | onchain      |

**It is not semantic review.** v1 checks that a plan exists, who wrote it, where,
and how recently. Whether the plan actually _describes_ the effect is a judgement
no string comparison makes honestly, and it is deliberately not claimed. What the
mode guarantees is that a human reading the thread saw something before the
effect, recent enough to still be the current intent.

## Modes

| Mode           | What needs a plan                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `off`          | nothing — what crews did before this existed                                                         |
| `spends_only`  | onchain proposes: a flow's `gate` step, `lacrew_propose_intent`                                      |
| `side_effects` | spends, plus connector writes, external MCP writes, and the `org` / `budget` / `governance` mutators |

Reads are never gated, in any mode. A confirmation in front of a read protects
nothing and teaches a crew to post plans nobody reads.

`lacrew_say` is not an effect either — which is what lets a flow post its plan
and then act in the same run.

## What counts as a plan

Four things, each of them a way the control could otherwise be faked:

- **kind `plan`** — a `note` saying "about to merge" is not a plan.
- **authored by the acting agent** — a seat cannot ride another seat's plan, and
  a _human_ writing "we should ship this" is not the agent stating its intent.
- **in a thread that agent speaks in** — its own thread, a crew thread above it,
  or `org`. A plan posted where nobody supervising the crew reads it satisfies
  nothing.
- **fresh** — inside the window (30 minutes by default), _or_ tagged with the run
  being executed. Without a bound, one plan posted at 9am rubber-stamps
  everything the crew does that day.

The same-run exception is what makes a long pipeline workable: a plan the run
already emitted counts however long the run has been going, because the
guarantee is the same — the operator saw _this run_ say what it was about to do.

## Turn it on

Self-host default is `off`. From the CLI:

```bash
lacrew plan-required list                      # what is in force
lacrew plan-required list --as 0xWORKER        # what one seat runs under

lacrew plan-required set --workspace --mode spends_only
lacrew plan-required set --crew 0xDESK --mode side_effects --window-min 15
lacrew plan-required set --agent 0xBOT --mode off          # carve one seat out
lacrew plan-required clear --agent 0xBOT                   # inherit again
```

Or from the environment, for a deployment that wants one setting and no runtime
edits:

| Variable                          | Meaning                                               |
| --------------------------------- | ----------------------------------------------------- |
| `LACREW_PLAN_REQUIRED`            | `off` (default) \| `spends_only` \| `side_effects`    |
| `LACREW_PLAN_REQUIRED_WINDOW_MIN` | how long a plan stays current (default `30`)          |
| `LACREW_PLAN_REQUIRED_UPSTREAM`   | `1` — a delegating manager's plan covers its delegate |

Precedence is narrowest-first: an `agent` rule beats the nearest `crew` rule,
which beats `workspace`. That ordering is what lets you write one broad rule and
carve exceptions out of it.

## From a blueprint

A [crew blueprint](./crews.md#recommended-supervision) can carry the mode it
recommends, and an install that asks for it applies the rule with no CLI at all:

```bash
lacrew crews plan github-experts --apply-recommended-controls
```

Recommended, never implied: a blueprint that turned this on for whoever picked
it would be requiring a plan from a crew whose operator never agreed to it.

## Delegation

When a manager delegates to a worker, the **worker** is the seat that must have
planned — it is the one doing the spending, and "have the desk rebalance" is not
the worker's statement of what it is about to do.

`--accept-upstream` (or `acceptUpstreamPlan`) relaxes that for handoff-shaped
crews where the manager plans and workers execute.

## What a refusal looks like

The step fails with `plan_required:<tool>:<none|stale>` and an instruction:

```
plan_required:github.merge_pull_request:none — github.merge_pull_request is a
side effect and this crew runs in plan-required mode (side_effects). 0xworker
has posted no plan in its thread. Post a `plan` message saying what you are
about to do, then retry. A plan approves nothing — the policy stack still
applies.
```

Nothing was built, no policy was consulted, and **no request left the process** —
"blocked" means the far side never heard from us.

Outside a flow, `POST /mcp/call` answers `409` rather than `403`: the caller is
admitted to take this action and is missing a step, which is a different fix
from "you may not".

## Audit

| Event                 | When                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `PlanRequiredBlocked` | a side effect was refused — tool, effect, principal, mode, and whether the plan was missing or stale |
| `PlanRequiredChanged` | somebody set or cleared a rule                                                                       |

Never the thread's contents: a plan body names counterparties, repositories and
amounts, and the trail is not the place to publish one.

`PlanRequiredBlocked` is the only trace an unplanned attempt leaves, which is
exactly why it is recorded — it is the row that answers "what did this crew want
to do that it did not do?"

## Failing open

If the rules cannot be read, crews keep working exactly as they did before
anyone turned the mode on, and the orchestrator says so loudly at boot.

This is the opposite of how [inference budgets](./inference-budgets.md) and the
[external MCP allowlist](./external-mcp.md) fail, and the difference is what each
one bounds. A budget guards money and an allowlist guards reach, so an unreadable
one has to refuse. Plan-required guards _legibility_ — every onchain cap,
whitelist, connector mode and human gate still stands behind it — and stopping a
funded desk over a database blip would trade a real outage for a missing
sentence.

## Routes

| Route                      | What it does                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /plan-required[?as=]` | rules in force; `?as=` also resolves one seat the way a call would                                         |
| `PUT /plan-required`       | set a rule (`{scope, mode, windowMs?, minPlanChars?, acceptUpstreamPlan?}`), or clear it with `mode: null` |

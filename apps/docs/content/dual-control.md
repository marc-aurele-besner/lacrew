---
title: "Dual control"
---

Policy bounds what a crew _may_ do. [Plan-required](./plan-required.md) bounds
when it may do it without having said so. Neither catches the plan that is
simply wrong — a hallucinated venue, a merge target injected through a tool
result, a goal that drifted three steps ago. One agent can plan the thing,
propose it and, under cap, execute it, and every control it passed was a control
about the _agent_ rather than about the _decision_.

Dual control is the four-eyes rule for that gap:

> **A second seat concurs, or the effect does not happen.**

Before a matching side effect, the runtime asks a different seat — a peer, the
manager above, or a person — to concur in the thread, and parks the run until
one does. Reject stops the effect. Nobody answering stops it too.

## What it is not

**It is not authority over money.** Concurring releases a step the acting seat
was already permitted to take. It cannot finalize an intent, widen a cap, or
admit a call PolicyModule refused, and a spend behind a concurrence still meets
the policy stack and still escalates. EscalationRouter and GovernanceModule
remain the only things that decide about the treasury and the constitution.

**It is not a quorum of trust.** Two agents on one orchestrator are two
processes with one blast radius: whatever compromised the actor may well reach
the reviewer. Dual control raises the cost of a single injected prompt; it does
not make a crew self-governing. High-tier treasury changes still need human
governance, and if the thing you are protecting is the treasury rather than the
workflow, set `--reviewer role:human`.

**It is not the human gate.** A [blocking human gate](./flows.md) stops a run at
a step the _flow author_ chose. Dual control stops it at an effect the
_operator's policy_ matched — wherever in the run it happens, including inside a
delegated flow.

Five controls, five different questions, and it is worth keeping them apart:

| Control                | Question it answers                                     | Who decides                | Where        | Fails       |
| ---------------------- | ------------------------------------------------------- | -------------------------- | ------------ | ----------- |
| Plan-required (F2.31)  | did the agent say what it was about to do?              | the agent itself           | orchestrator | open        |
| Dual control (F2.32)   | does a **second seat** agree with this specific effect? | another agent, or a person | orchestrator | closed      |
| Human gate (F2.27)     | does a person agree, at this step?                      | a human seat               | orchestrator | as declared |
| Approvals / `ESCALATE` | is this spend admitted, and by whom?                    | the org chart + policy     | **onchain**  | closed      |
| Governance             | may the constitution change?                            | weighted vote + timelock   | **onchain**  | closed      |

The two off-chain review controls compose in the obvious order: the agent posts
a plan, a second seat reads it and concurs, and only then does the effect go
out. Neither one approves a spend; both sit in front of the same policy stack
that was always there.

## Modes

| Mode                | What needs a second seat                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `off`               | nothing — what crews did before this existed                                                                        |
| `risky_writes`      | connector and external-MCP writes, and the `org` / `budget` / `governance` mutators. A merge, a publish, a reparent |
| `spends_and_writes` | those, plus onchain proposes at or above `minSpend`                                                                 |

Reads are never reviewed, in any mode. `lacrew_say` carries no effect either, so
a crew can still talk while a review is open.

`lacrew_approve_intent` is deliberately never reviewed: approving _is_ the
second pair of eyes — a manager answering something a worker escalated — and
reviewing a review would stall the escalation path.

### Thresholds

Within a mode, three composable flags narrow what qualifies:

| Flag                       | Default                   | Meaning                                     |
| -------------------------- | ------------------------- | ------------------------------------------- |
| `--min-spend <base units>` | `0` (every spend)         | proposes below this are not reviewed        |
| `--no-connector-writes`    | connector writes reviewed | leave connector + external-MCP writes alone |
| `--no-org-mutators`        | org mutators reviewed     | leave `org` / `budget` / `governance` alone |

The threshold reads the number the propose itself carries. A value the
orchestrator cannot parse is reviewed whatever the floor says — the alternative
is a spend escaping review because its amount was malformed.

## Who reviews

| Reviewer            | Resolves to                                                                          |
| ------------------- | ------------------------------------------------------------------------------------ |
| `manager` (default) | the nearest available seat above the actor; a human root if that is what is above it |
| `seat:0x…`          | one named seat — for a dedicated reviewer agent                                      |
| `role:human`        | a person, always. The only setting that does not depend on an agent being honest     |
| `any_peer_in_crew`  | any other active seat under the same manager                                         |

Resolution walks the live org chart on every review, so a reparent moves a
crew's reviewer with it.

**The actor is never a reviewer of its own effect.** That is not a rule applied
after the fact: the actor is removed while the reviewer set is built, so a
`seat:` rule that names the actor resolves to a person instead, and a crew of
one has no peers to ask. An answer from the acting seat resolves nothing and is
recorded as `DualControlUnresolved` with `reason: self_concurrence`.

**A person may always answer in place of an agent reviewer.** A crew whose
reviewer agent is paused, fired or wedged must not be a crew that is frozen
until an operator edits policy, and the alternative operators reach for in that
situation is turning dual control off entirely. When the configured reviewer is
unavailable the review escalates to the people in the chart and the record says
`escalated: true` — a deployment whose reviews are all escalated has a reviewer
setting that is not doing what it says.

## What a reviewer sees

A `question` in the thread, naming the seat, the tool, the amount if there is
one, and the fields the call would carry:

```
Second pair of eyes: 0xworker is about to call github.merge_pull_request.
Tool: github.merge_pull_request

  owner: acme
  repo: site
  number: 7
  merge_method: squash

This run is paused until a different seat answers. Reply with exactly one of: concur, reject.
Concurring releases a paused step only: it approves no spend, changes no policy and signs
nothing onchain. The policy stack, the escalation path and human approvals all still apply.
```

Only `concur` and `reject` count. "looks fine to me" is a sentence a reviewer
means as a yes and a parser can only guess at, and a wrong guess here is an
effect nobody agreed to — so free text resolves nothing, and the question is
re-posted so a paused run never disappears from the queue.

An agent reviewer is asked in its own thread. People are asked in the actor's
thread, which is the one the Questions rail surfaces and the one carrying the
context a person needs to decide.

## One concurrence, one effect

A review is keyed by a hash of the call that will go out — the tool and its
arguments — together with the run. Merging PR #7 and merging PR #9 are different
reviews with different questions, and the concurrence given for one can never
release the other. A concurrence is also spent exactly once: the run that acted
on it marks it consumed, so a restart cannot replay the released effect.

### …unless the crew reviews per run

`reviewScope` decides how much one answer releases:

| Scope                  | One concurrence releases                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `per_effect` (default) | this call, with these arguments, and nothing else                                           |
| `per_run`              | every reviewed effect the **same run** by the **same seat** reaches, until reject or cancel |

Per effect is the only scope where what the reviewer read is what happened, so
it is the default and the one to leave alone unless the noise is real. A desk
that proposes in a loop asks the same person the same question a dozen times,
and a queue nobody can keep up with is a queue that gets rubber-stamped — which
makes the noisier control the weaker one in practice.

What `per_run` widens is not hidden. The reviewer is agreeing to a _run_ having
seen its first effect, so the second is released on trust in the run rather than
on a reading of the call, and the question says exactly that:

> This crew reviews per run: concurring releases every reviewed effect this run
> still reaches, not only the one above. Reject if you would want to see the next
> one.

It belongs on a crew whose effects are the same shape repeated. It does not
belong where the next call could be an order of magnitude larger than the one
that was reviewed.

The rest of the control is unchanged: the actor still cannot answer, a rejection
still refuses, and cancelling the run closes the concurrence with it. Each
released effect leaves its own `DualControlConcurred` row carrying the tool and
fingerprint of _that_ call, so the trail shows what one answer actually carried.
A call arriving outside a flow has no run to scope to, and reviews per effect
whatever the setting says.

## Restarts and timeouts

The run is parked on durable state rather than blocked in memory, so a redeploy
mid-review loses nothing: whichever replica sees the answer resumes the run.

If nobody answers before the timeout (a day by default, `--timeout-min` to
change it), the review expires and **the effect fails closed** — the step
refuses and nothing goes out. This is the opposite direction from a human gate,
which takes a declared timeout port. For a control whose whole purpose is a
second pair of eyes, "nobody looked" must never read as "somebody agreed".

Cancelling a run closes the reviews it was holding, so a late concurrence lands
on a closed question instead of restarting work the operator ended.

## Failing closed

If the rules cannot be read, the effects they cover are refused and the
orchestrator says so loudly at boot.

This is the opposite of how [plan-required](./plan-required.md) fails, and the
difference is what each one bounds. Plan-required guards legibility, so an
outage there costs a missing sentence. Dual control is the second pair of eyes
an operator put in front of a merge or a spend, and an outage that quietly
removed it would deliver precisely the unreviewed effect they were paying to
prevent.

## Configuring

```bash
lacrew dual-control list --as 0xWORKER   # what one seat runs under, and who would be asked
lacrew dual-control reviews              # what is holding runs right now

lacrew dual-control set --workspace --mode risky_writes
lacrew dual-control set --crew 0xDESK --mode spends_and_writes \
  --reviewer role:human --min-spend 1000000
lacrew dual-control set --crew 0xDESK --mode spends_and_writes --review-scope per_run
lacrew dual-control set --agent 0xBOT --mode off      # carve one seat out
lacrew dual-control clear --agent 0xBOT               # inherit again
```

Or from the environment, for a deployment that wants one setting and no runtime
edits:

| Variable                           | Meaning                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `LACREW_DUAL_CONTROL`              | `off` (default) \| `risky_writes` \| `spends_and_writes`      |
| `LACREW_DUAL_CONTROL_REVIEWER`     | `manager` \| `seat:0x…` \| `role:human` \| `any_peer_in_crew` |
| `LACREW_DUAL_CONTROL_MIN_SPEND`    | base units; spends below this are not reviewed                |
| `LACREW_DUAL_CONTROL_TIMEOUT_MIN`  | how long a review waits before failing closed                 |
| `LACREW_DUAL_CONTROL_REVIEW_SCOPE` | `per_effect` (default) \| `per_run`                           |

A bad value stops the boot rather than defaulting: an orchestrator whose
reviewer setting silently became `manager` would be reviewing to a seat nobody
chose.

Precedence is narrowest-first: an `agent` rule beats the nearest `crew` rule,
which beats `workspace` — write one broad rule and carve exceptions out of it.

## Delegation

The seat that would _act_ is the one checked against the reviewer. When a
manager delegates to a worker and the worker reaches a reviewed effect, the
worker's rule applies and the worker's reviewer is asked — which will often be
the delegating manager, and that is real dual control: two seats, two decisions.

## What a refusal looks like

```
dual_control_rejected:github.merge_pull_request — a second seat
(0xmanager) rejected this effect; it was not attempted.
```

Nothing was built, no policy was consulted, and **no request left the process**.

Outside a flow there is no run to park, so `POST /mcp/call` answers `202` with
the review id while it is open, and `409` once it has been rejected or has
expired. The review is keyed by the call, so retrying finds the same question
rather than minting another.

## Audit

| Event                   | When                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `DualControlOpened`     | an effect parked on a review — tool, actor, who was asked, whether it escalated      |
| `DualControlConcurred`  | a second seat agreed and the effect proceeded                                        |
| `DualControlRejected`   | a second seat refused (or the run was cancelled mid-review)                          |
| `DualControlTimedOut`   | nobody answered; the effect failed closed                                            |
| `DualControlUnresolved` | somebody replied without deciding — including the actor trying to concur with itself |
| `DualControlChanged`    | somebody set or cleared a rule                                                       |

The rows carry a fingerprint of the call and, for a spend, the amount — never
the arguments. A call's fields name repositories and counterparties, and the
trail is not the place to publish one.

## Routes

| Route                                        | What it does                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dual-control[?as=]`                    | rules in force; `?as=` also resolves one seat and the reviewer it would actually get                                                        |
| `PUT /dual-control`                          | set a rule (`{scope, mode, reviewer?, minSpend?, connectorWrites?, orgMutators?, timeoutMs?, reviewScope?}`), or clear it with `mode: null` |
| `GET /dual-control/reviews[?status=&runId=]` | the review queue                                                                                                                            |

Concurring happens through the conversation, never through a route: an endpoint
that resolved a review directly would be a second way to release an effect, and
one that never sees whether the answer came from a different seat.

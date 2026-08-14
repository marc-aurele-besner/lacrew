---
title: "Inference cost budgets"
---

> **Onchain budget ≠ inference budget.** They bound different money, are
> enforced in different places, and one is not a substitute for the other. If
> you read nothing else, read [The two budgets](#the-two-budgets).

A crew's onchain spending is bounded by a streamed allowance and a policy stack.
Its _model_ spending is bounded by nothing — and a heartbeat on a frontier
model, a flow that loops, or one badly-scoped delegate can cost more than the
desk's clip size while every onchain number still reads healthy.

An inference budget closes that hole with the same mental model as a spend cap:
bounded, visible, escalatable.

```bash
lacrew budget set --crew trading \
  --usd 200 --period calendar_month \
  --hard --cheap-model claude-haiku-4-5 --enable
```

## The two budgets

|                | Onchain budget                                                     | Inference budget                              |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Bounds         | funds leaving the treasury                                         | what model calls cost you                     |
| Enforced by    | `SpendCapPolicy`, whitelist, allowance, session key — on the chain | the orchestrator, at `ModelProvider.complete` |
| Denominated in | USDC (or any stack asset)                                          | tokens, and best-effort USD                   |
| Raised by      | a governance proposal                                              | an operator setting, audited                  |
| When exhausted | the chain refuses the transfer                                     | the orchestrator refuses the completion       |

The invariants that keep them apart are worth stating plainly:

- **A cost budget moves no funds.** It cannot approve, deny or resize an onchain
  action, and it is **not a PolicyModule**. A crew that has burned its inference
  budget can still propose a spend, and that spend is judged by its policy stack
  exactly as before.
- **A hard stop fails closed on model calls only.** It never auto-approves a
  spend and never widens a session key.
- **The numbers you are shown are the numbers enforced.** No decorative
  progress bars: the UI, the CLI and the guard all read the same counter.

## What you can bound

Any subset of three limits, per period:

| Limit          | Unit                                                              |
| -------------- | ----------------------------------------------------------------- |
| `--usd`        | dollars, best-effort (see [Pricing](#pricing-and-honest-dollars)) |
| `--in-tokens`  | input tokens                                                      |
| `--out-tokens` | output tokens                                                     |

An **enabled** budget with no limit is refused: it would read as protection on
every surface and bound nothing. A _disabled_ one is fine — that is a form you
are still filling in.

### Periods

| `--period`                 | Window                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `calendar_month` (default) | the UTC calendar month — what a card statement looks like                                                |
| `epoch`                    | `--window-days`/`--anchor`-aligned to your payroll epoch, so inference and allowances roll over together |
| `window`                   | a **tumbling** window of `--window-days`, counted from `--anchor`                                        |

`window` is deliberately not a trailing "last 30 days". The enforced number is a
counter per period, and a trailing window would make the figure you are looking
at drift under you between two page loads with no event to explain it.

Rollover needs no sweep and no job: a new period is a new counter key, so the
next call simply writes somewhere new. For the same reason, **raising a cap
mid-period takes effect immediately** — the counter did not move, the limit it
is compared against did.

## Soft and hard

| `policy`          | At the line                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `soft` (default)  | warn: a note in the crew thread, an `InferenceBudgetExceeded` audit event. Nothing is blocked. |
| `hard` (`--hard`) | refuse further completions with `inference_budget_exceeded`                                    |

An alert also fires at **80%**, while there is still room to act. Both alerts
fire **once per crossing per period** — a crew at 81% of its budget produces a
completion every few seconds, and an alert per call is an alert nobody reads.

### The heartbeat is held, the crew is not paused

By default a hard breach also stops the crew's [heartbeat](./heartbeat.md). The
completions are already refused; without this the timer keeps waking and keeps
being refused, and the crew thread fills with failures nobody can act on.

The agent itself stays live, so a human in a thread is not locked out of the
crew because a scheduled sweep ran the budget down. Opt out with
`--keep-heartbeat`: the calls are still refused, the timer just keeps firing.

### Degrade before you stop

`--cheap-model <id>` names a model to fall back to once usage passes the warn
line. A crew that degrades is worth more than one that stops, and the swap
widens nothing — the cheaper model has the same tools, the same seat and the
same policy stack.

## Who pays for what

The meter key is a crew, optionally narrowed to one seat. A crew is a desk: its
**manager** in the org chart plus everything reporting to it — the same reading
[connector write policy](./connectors.md) uses. A seat with no manager is a crew
of one.

A seat's call is charged to **both** its own budget and its crew's, and both are
checked. So an agent budget can only ever **tighten** a crew budget, never widen
it: a seat with $50 left inside a crew with $2 left has $2. The alternative
would let per-agent budgets sum past the crew cap and quietly overspend it.

A call that names no crew is metered under **`unattributed`** rather than
escaping the count — it still costs money, and a total lower than your bill is
worse than an ugly bucket name. You can budget `unattributed` like any other
crew.

## Pricing, and honest dollars

Three sources, in order:

1. **The provider's own reported cost**, when it reports one. This is the number
   that will appear on the bill, so it always wins.
2. **A price table**, matched by longest model-name prefix after stripping a
   router prefix (`anthropic/…`) and a date stamp. Ships with list prices for a
   handful of common models; override the whole table with `LACREW_MODEL_PRICES`:

   ```bash
   export LACREW_MODEL_PRICES='{"claude-opus":{"inputPerMTok":15,"outputPerMTok":75}}'
   ```

   A table that does not parse falls back to the built-in one **whole** —
   honouring three of five overrides would enforce a number nobody wrote.

3. **Nothing.** A call neither the provider nor the table can price is counted as
   **unpriced**, never as free. Its tokens still count against token limits, and
   every surface that shows the dollar figure says how many calls it omits:

   ```
   Note        3 call(s) had no known price — the $ figure is a floor
   ```

If you care about the exact dollar number, bound tokens as well as USD, or set
`LACREW_MODEL_PRICES` to your negotiated rates.

## Where it is enforced

At `ModelProvider.complete`, wrapping whichever vendor client is configured —
not inside one vendor's client. A budget that only bound Anthropic calls would
be bypassed by switching `LACREW_MODEL_PROVIDER`, and a new provider should not
have to remember to opt in to being counted.

The check runs **before** the request goes out: a refusal after the call is a
report, not a limit. Metering runs after, from the provider's reported usage
when there is any and from an approximate token count when there is not (always
marked `tokens approx.`, so nothing mistakes it for a metered number).

A request that never reached the provider is not charged. A **store that cannot
be read fails the call closed** — an unreadable ledger is exactly the state a
runaway loop produces, and "we could not tell, so we kept spending" is the
failure this exists to prevent.

## Seeing the number

```bash
lacrew budget list                       # every budget, with live standing
lacrew budget show --crew trading        # one, in full
lacrew budget usage --crew trading       # the calls behind the number
```

`usage` is the breakdown: model id, tokens, estimated USD, and the run each call
belonged to — so _"why is this crew at 90%?"_ is answerable without opening a
provider's console.

Over HTTP:

| Route                               |                                            |
| ----------------------------------- | ------------------------------------------ |
| `GET /budgets`                      | every budget with its standing             |
| `GET /budgets/one?crewId=&agentId=` | one, narrowed                              |
| `POST /budgets`                     | save (audited as `InferenceBudgetChanged`) |
| `POST /budgets/enabled`             | toggle                                     |
| `POST /budgets/delete`              | remove                                     |
| `GET /budgets/usage?crewId=&limit=` | the per-call breakdown                     |

A refused completion answers `429` with the stable code:

```json
{
  "error": "inference_budget_exceeded",
  "scopeKey": "crew:trading",
  "dimension": "usd",
  "periodKey": "2026-07"
}
```

Inside a flow, the same code surfaces on the failing `model` step, so a flow
that models the case can branch on it.

## Persistence

Postgres when `DATABASE_URL` is set, memory otherwise — the same provider
pattern as flows and heartbeats. The counter is incremented **in SQL**, not
read-modify-written, so two replicas metering the same crew cannot lose a call
to a race; a lost call is unenforced spend.

Usage is recorded whether or not a budget exists on that scope, so the first
budget you write on a crew that has been running for weeks does not read as
zero-used.

Without Postgres the counters live in one process and do not survive a restart —
fine for a single-node self-host, not a fleet.

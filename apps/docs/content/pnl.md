# Crew P&L

> **Reporting, not authority.** Nothing on this page approves a spend, releases
> an escalation, changes a cap, or moves a token. It reads three meters and puts
> them on one period.

"What did this crew cost last week?" currently means opening Treasury for USDC
intents, Billing for operation counts, and the audit trail for connector calls,
then reconciling three windows by hand. A crew P&L answers it in one read:

```bash
lacrew pnl --crew 0x2222…2222 --period calendar_week
```

```
0x2222…2222  2026-W31  (2026-07-27T00:00:00.000Z → 2026-08-03T00:00:00.000Z UTC)
  asOf        2026-07-31T12:00:00.000Z
  Onchain     50.00 USDC spent · 75.00 pending · 200.00 granted
  Inference   $4.5000 · 128 call(s) · 412300 in · 96100 out  (3 unpriced — this is a floor)
  Connectors  46 call(s) · 7 write · 39 read · 1 failed · price unknown
  Budget      hard · ok · $195.50 left of $200.00 (period 2026-07)
```

## What the lines mean

| Line            | Source of truth                                                                | Denominated in                              |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| Onchain spent   | `AllowanceSpent` / `ActionExecuted` on the audit trail, deduped by transaction | the asset's own base units                  |
| Onchain pending | escalations created and not resolved inside the window                         | the asset's own base units                  |
| Onchain granted | `AllowanceStreamed` — what the epoch put into a seat's allowance               | the asset's own base units                  |
| Marketplace     | `MarketplacePurchase` that settled — listed apart from ordinary spend          | the asset's own base units                  |
| Inference       | the F2.28 counters, per metered call                                           | tokens, and best-effort USD                 |
| Connectors      | `ToolCalled` rows, by connector and route                                      | calls; USD only where a price table says so |

**Onchain budget ≠ inference budget.** They are shown side by side and never
added together: one bounds funds leaving the Treasury under a policy stack, the
other bounds what the crew's model calls cost you. See
[Inference cost budgets](./inference-budgets.md#the-two-budgets).

## Honesty rules

These are the reasons a figure may look "missing", and each one is deliberate.

- **`price unknown` is never `$0`.** A model call no provider priced and no
  price table covers is counted as a call, its tokens are counted, and the `$`
  figure says how many calls it omits. The same holds for connectors: with no
  price table configured, connector usage reports call counts and states that
  the price is unknown.
- **`available: false` is not a zero.** If inference metering is not configured,
  the report says model cost is unmeasured rather than showing `$0.00`.
- **A partial window says so.** Without a database, the orchestrator answers
  from a bounded in-process ring; the report is flagged incomplete because a
  window that quietly forgot its oldest rows is a lower bill than the one you
  will be sent.
- **Seat rows that do not sum are named.** A model call charged to the crew
  without naming a seat lands in `unattributed` and is called out in the notes,
  rather than being spread across seats that did not incur it.
- **Pending is not spent.** An escalation awaiting a decision has moved nothing,
  and it is listed on its own line.

## The period

UTC, always. A workspace timezone would move month boundaries, and a figure that
changes with the reader's timezone is not one an accountant can check.

| `--period`                 | Window                                               |
| -------------------------- | ---------------------------------------------------- |
| `calendar_month` (default) | the UTC month `now` falls in                         |
| `calendar_week`            | the ISO week (Monday-anchored)                       |
| `epoch`                    | one epoch, from `--epoch-seconds` / `--epoch-anchor` |
| `--from` / `--to`          | exactly those instants; wins over `--period`         |

Windows are half-open (`[from, to)`), so two adjacent periods never both claim a
row that landed on their boundary. A range longer than 366 days is refused
rather than silently truncated.

## Pricing connector calls

Nothing ships pre-priced — LaCrew does not know what your workspace pays GitHub
or Notion. Supply a table and the routes it covers get a `$` figure; the rest
stay honestly unpriced:

```bash
export LACREW_CONNECTOR_PRICES='{"github.merge_pr":0.01,"notion":0.002}'
```

The narrower key wins (`<connector>.<route>` over `<connector>`), and a negative
or unparseable entry is dropped rather than applied.

## HTTP

```
GET /pnl?crewId=0x…&period=calendar_month
GET /pnl?crewId=0x…&agentId=0x…&from=<ISO>&to=<ISO>
GET /pnl?crewId=0x…&period=calendar_week&format=csv
```

`format=csv` returns the same aggregate as a flat, one-row-per-line-item export;
the `usd` cell is left empty where nothing could price the row and `price_known`
says which of the two a blank means, so a spreadsheet cannot sum an invented
zero.

On the cloud the same report is served per crew and per seat, scoped to the
workspace's own org chart:

```
GET /v1/crews/:id/pnl?period=calendar_month
GET /v1/agents/:id/pnl?from=<ISO>&to=<ISO>
```

An address that names no node in the caller's org answers `404`, not `403` —
whether another workspace runs a crew at that address is not information this
caller has a claim to.

## What it does not do

- It is not double-entry accounting and it is not an ERP export. It is what an
  operator needs to answer "is this desk inside both of its budgets?".
- It does not replace Stripe invoices, and it does not bill anything.
- It does not stream. Period aggregates carry an `asOf` stamp and may be
  seconds behind; polling is enough for a report nobody acts on.
- It never widens authority. A P&L that could act would be a second enforcement
  path for money, and there is exactly one of those — the chain.

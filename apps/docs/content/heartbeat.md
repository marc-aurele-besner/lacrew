# Crew heartbeat

A crew runs when you press Run, when an epoch fires, when a cron expression on a
flow matches, and when a signed webhook arrives. None of those is _"every half
hour, work through this desk's list and tell me what needs a person."_

That is a heartbeat: a cadence, a **standing checklist**, and one summary in the
crew thread.

```bash
lacrew heartbeat set --crew trading \
  --schedule '*/30 * * * *' --timezone Europe/Paris \
  --quiet-start 22:00 --quiet-end 07:00 \
  --flow desk-risk-sweep,desk-digest --skill morning-review \
  --as 0xWORKER --model cheap/model --enable
```

## It only runs what you named

A heartbeat is **not** an agent deciding what to do on a timer. Every item is a
flow id or a skill id that already exists on this orchestrator, and there is no
step where a model picks work for itself. The consequence is the whole design:

- **It widens nothing.** Each item runs as a declared seat, down the same
  `flows.run` path a manual run takes. The policy stack, the session key's
  onchain ceiling, the pause gate and Approvals all still apply. A gate inside a
  heartbeat-triggered flow still escalates; a heartbeat never auto-approves.
- **A skill item has no tools.** The skill's body is put to the model as a single
  `model` step, so it can read and reason and report — it cannot call anything.
  If you want the crew to _act_, put the flow that acts on the checklist.
- **Unknown ids are refused at save time.** A checklist naming a flow this
  orchestrator does not have, or a skill the seat's directive does not carry, is
  a 400. A typo you find out about at 03:00 is a typo you find out about from a
  thread note nobody reads until morning.

## Heartbeat or per-flow cron?

Both fire on a schedule. They answer different questions.

|          | Per-flow `trigger: "cron"` | Crew heartbeat                              |
| -------- | -------------------------- | ------------------------------------------- |
| Lives on | one flow definition        | the crew                                    |
| Runs     | that flow                  | an ordered list of flows **and** skills     |
| Timezone | UTC only                   | any IANA zone, with quiet hours             |
| Reports  | a run trace                | one thread summary per tick, with run refs  |
| Answers  | "run this thing regularly" | "is anything wrong, and who needs to look?" |

Use a per-flow cron when a flow is its own reason to exist. Use a heartbeat when
what you want back is a _supervision report_ — several checks, one legible
answer, in the crew's thread.

## Cadence, timezone, quiet hours

The schedule is an ordinary 5-field cron expression, read in the heartbeat's
timezone. `lacrew heartbeat presets` lists the cadences worth offering by name;
they are just expressions.

Quiet hours are a window in the same zone (`22:00` → `07:00` wraps midnight). A
tick inside them is **skipped, not deferred**: the next window outside them runs
normally. Queueing suppressed ticks would deliver a burst of stale work at
exactly the moment someone starts reading.

Timezones go through `Intl`, so daylight saving is handled: a heartbeat set to
`0 9 * * 1-5` in `Europe/Paris` fires at 09:00 Paris time on both sides of a
clock change.

### The cadence floor

A schedule that fires more often than every **10 minutes** is refused. Every tick
spends — model calls, connector calls, gas on anything that proposes — and this
is the one surface where a single character in the minute field multiplies that
tenfold with nothing in the way. If you genuinely need a denser cadence, that is
a per-flow cron with its own reason.

## What lands in the thread

One message per tick, in `crew:<crewId>`.

- **Nothing needed you** → a short `note` beginning `HEARTBEAT_OK`. On by
  default (`notifyOnOk`); turn it off with `--quiet-on-ok`. Silence is a
  decision, not a default: a heartbeat that says nothing when all is well is
  indistinguishable from one that stopped running.
- **Something needs you** → a `result` naming each item, its seat, and what it
  reported. This is posted **whatever `notifyOnOk` says** — that setting governs
  the quiet case only, and never suppresses a failure.

Both carry `refs` to every flow run they caused, so the claims are checkable
against the runs rather than taken on trust.

The summary is a `result` rather than a `question` on purpose. Items that
genuinely need an answer ask it themselves — an ask-mode connector write
(F2.24) posts its own question, in the thread, where answering it releases the
step that is waiting. A heartbeat posting its own question every tick would fill
the Questions rail with entries nobody can close.

## Failure, pauses, and overlap

- A failing item does **not** stop the tick by default; the rest of the list
  still runs. `--stop-on-error` reverses that.
- A **paused** seat is skipped, and the skip is reported by name. A silent gap in
  the ledger reads as a clean tick.
- **Concurrent ticks are coalesced.** The runner claims the firing window in the
  store before doing any work, so a redelivered sweep or a second replica finds
  it taken. A tick still running when the next window opens blocks that window
  for up to 30 minutes, after which the process holding it is presumed dead.

Multi-replica safety comes from two places at once: the minute sweep is
dispatched by the queue to exactly one worker, and the window claim is a unique
row. Either alone would be enough in the common case; both are what make
double-firing a funded checklist not happen.

## Addressing: self-host and cloud

**A heartbeat's `crewId` is its thread key.** There is one crew namespace, not
two: the summaries for `crewId: "trading"` land in `crew:trading`, which is the
thread any surface listing that crew already reads. `heartbeatThreadId(crewId)`
in `@lacrew/orchestrator` is that agreement in one function, so a caller never
has to reconstruct the format.

Self-hosting, this needs no thought: your orchestrator serves one organization,
and `trading` means your trading desk.

A **shared** orchestrator is different, and it is the one thing to get right
before pointing several workspaces at one process. Crew ids are display names
there, and two customers both naming a desk `trading` would otherwise share one
heartbeat row and one thread. So a control plane in front of a pooled
orchestrator must qualify the crew id per tenant — `t.<tenant>.trading` — and it
must do so for the **thread and the heartbeat together**, using the same string
for both. Scoping only one of them is the failure worth naming: a heartbeat
saved under a qualified id whose summaries are read from an unqualified thread
posts into a thread nobody opens, and every tick looks like silence.

The orchestrator does not do this qualifying for you. It has no notion of a
tenant — that is exactly the sort of multi-tenant plumbing that stays out of the
open core — and it treats whatever id it is handed as opaque.

## Cost

A heartbeat is the most frequent thing a crew does, and usually the least likely
to need your best model. `--model` sets a cheaper model for the tick's **skill**
items; flow items use whatever their own steps declare.

The arithmetic is worth doing before you enable one: a 5-item checklist on a
30-minute cadence is 240 items a day, 7,200 a month. Quiet hours cut roughly a
third of that for a desk that only matters in working hours.

### What a tick actually cost

When inference metering is wired ([inference budgets](./inference-budgets.md)),
a finished tick carries a `usage` rollup of the model calls its runs made:
tokens each way, micro-dollars, and how many calls could not be priced. It is
the same counter the budget guard enforces against — the figure you read is the
figure that refuses a call — and it is reported in the tick's thread summary as
a `Spend:` line.

Two absences mean different things and are kept apart:

- **No `usage` at all** — nothing metered this tick. Unmeasured, not free.
- **`unpricedCalls > 0`** — some calls had no known price, so the `$` figure is
  a floor rather than a total, and the summary says so.

A tick that made no model call reports no spend line rather than `$0.00`, so the
line stays worth reading.

## Routes

| Route                      | What it does                                              |
| -------------------------- | --------------------------------------------------------- |
| `GET /heartbeats`          | Every heartbeat, its last tick, the presets and the floor |
| `POST /heartbeats`         | Save one (body `{ heartbeat }`); unknown ids are refused  |
| `POST /heartbeats/enabled` | Enable / disable (body `{ crewId, enabled }`)             |
| `POST /heartbeats/delete`  | Remove (body `{ crewId }`)                                |
| `POST /heartbeats/run`     | Work the checklist now, off-schedule                      |
| `GET /heartbeats/ticks`    | The tick ledger (`?crewId=`, `?limit=`)                   |

`POST /heartbeats/run` takes its own window key, so testing a config never
swallows the scheduled tick you were testing.

Storage is Postgres when `DATABASE_URL` is set (`orchestrator_crew_heartbeats`,
`orchestrator_crew_heartbeat_ticks`), memory otherwise — and only the durable
store coordinates replicas.

## Audit

Two event types, distinct from the `FlowRun` rows the items produce:

- `CrewHeartbeatChanged` — the checklist or its cadence was edited, enabled,
  disabled or removed. A heartbeat is standing authority to start funded work on
  a timer, so putting a flow on the list is attributable.
- `CrewHeartbeat` — one tick finished: how many items ran, how many need a
  human, which runs it caused. This is also the row that makes an _absent_
  heartbeat visible: a crew whose last tick is three days old is not a quiet
  crew, it is a stopped one.

## CLI

```
lacrew heartbeat presets                     Cadences worth offering by name
lacrew heartbeat list                        Every heartbeat on this orchestrator
lacrew heartbeat show --crew trading         One in full
lacrew heartbeat set --crew trading …        Create or replace
lacrew heartbeat on|off --crew trading       Enable / disable
lacrew heartbeat run --crew trading          Work the checklist now
lacrew heartbeat ticks --crew trading        What the last ticks did
lacrew heartbeat remove --crew trading       Drop it
```

Set `ORCH_URL` (or pass `--url`) and `ORCH_TOKEN` to reach a remote
orchestrator.

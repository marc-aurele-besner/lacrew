# Crew blueprints

A blueprint is a vertical written down: the org chart, the per-seat caps and
grants, the escalation ladder, the constitutional changes, the flows the crew
runs — and, for every "this must never happen", the layer that actually refuses
it.

Blueprints ship in `@lacrew/flows` and need no chain access to read:

```bash
lacrew crews list
lacrew crews show defi-desk
lacrew crews plan defi-desk --bind executor=0x… --bind target:dex-router=0x…
```

Three first-party blueprints come from filled design-partner intakes
(`design-partner-intake.md`), one per vertical:

| Blueprint        | Vertical | Shape                                                                                           |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `defi-desk`      | Trading  | Scanner, planner, executor, rebalancer under a risk manager who can halt the desk               |
| `github-experts` | Dev      | Watcher, reviewer, merger, fixer, release scribe under a review lead                            |
| `content-studio` | Content  | Ideation, writer, three-seat review board, visual packager, social desk under an editor manager |

The rest are author-drafted patterns. They carry no `intake.file`, and the
absence is the honest signal rather than an oversight: their caps and grants are
a starting point somebody reasoned about, not a figure a real operator gave.
Pointing them at a document that does not exist would lend partner-derived
authority to a guess.

| Blueprint         | Vertical | Shape                                                                       |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `research-desk`   | Research | Source scout, analyst and librarian under a research lead                   |
| `support-desk`    | Support  | Triager and responder under a desk lead                                     |
| `platform-oncall` | Ops      | Monitor and remediator under an on-call lead                                |
| `lp-advisor`      | Trading  | Position mapper, range analyst and depth watch under an advisory lead       |
| `yield-desk`      | Trading  | Rate scout, risk scorer and allocator under a treasury lead                 |
| `risk-watch`      | Ops      | Peg, oracle and event watches under a risk lead                             |
| `governance-desk` | Research | Proposal scout, rationale writer and conflict checker under a delegate lead |

The first three ship no flows, because how a support desk or an on-call rota
actually works is the part most specific to one team, and inventing it would be
the same fabrication one level down. The four DeFi patterns each ship one,
because there the pipeline _is_ the claim: "this crew can only advise" is not a
sentence in a summary, it is a policy check `lp-range-review` performs against a
router nobody admitted — and it is only checkable because the flow runs it.

Each of the four is built around a different layer:

| Blueprint         | What it demonstrates                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lp-advisor`      | A crew with no execution authority at all. No venue and no payout target is admitted, so the advice is a property of the whitelist rather than a promise                                                               |
| `yield-desk`      | Admission as the risk control. It carries an unadmitted-market entry so the refusal path is exercised, and its allocator holds a dedicated stack because the org-wide whitelist admits a market for every seat at once |
| `risk-watch`      | Detection is not prevention. Every guardrail states its residual risk, not only the `monitoring` ones validation demands it of                                                                                         |
| `governance-desk` | An onchain action that moves no value. The cap, the whitelist and the allowance all answer ALLOW on a vote, and the blueprint says so instead of implying the policy stack covers it                                   |

## What a blueprint holds

```ts
import { getCrewBlueprint, crewPlan, validateCrewBlueprint } from "@lacrew/flows";

const bp = getCrewBlueprint("github-experts")!;
validateCrewBlueprint(bp); // { ok: true, errors: [] }
```

| Field            | What it answers                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `roles`          | The org chart: kind, who it reports to, its charter, its per-call `capUsdc` and per-epoch `grantUsdc` |
| `targets`        | Where money may go, and which targets are deliberately **not** whitelisted                            |
| `externalScopes` | Credentials LaCrew does not govern — a GitHub App, a draft-only social token                          |
| `escalation`     | The "ask me first" ladder, and which layer carries each rung                                          |
| `governance`     | Which changes are constitutional, and at which tier                                                   |
| `guardrails`     | Each "must never happen", its enforcement layer, and its residual risk                                |
| `outOfScope`     | What the crew deliberately does not do                                                                |

### Enforcement layers

Every guardrail names where it is enforced, because a config that implies the
chain refuses something it has never seen is worse than no config:

| Layer        | Meaning                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`     | A policy module — cap, whitelist, rate limit, time window. DENY is final.                                                                   |
| `treasury`   | Allowance topology: seats spend their own stream, never the treasury.                                                                       |
| `session`    | The session key's own limits; the key cannot sign it at all.                                                                                |
| `governance` | Proposal, quorum, and — at the high tier — timelock plus human veto.                                                                        |
| `escalation` | The action waits for a manager or the human root.                                                                                           |
| `flow`       | The pipeline's own routing. Real, but orchestrator-side.                                                                                    |
| `external`   | A credential scoped outside LaCrew.                                                                                                         |
| `monitoring` | Detected after the fact by Guardian. Not prevention — and a guardrail on this layer must state its residual risk, or validation rejects it. |

`validateCrewBlueprint` also rejects a manager whose cap is smaller than a
report's (the escalation would dead-end), a reporting cycle, a worker acting as
a parent, a seat spending on an unlisted target, a flow the blueprint does not
ship, and an escalation ladder that never reaches a human.

## Whitelists are org-wide

The default `WhitelistPolicy` allows a target for the whole org, not per seat.
A blueprint's `targets` are therefore an org-level answer, and `crewPlan` emits
one whitelist call per target rather than one per seat.

When a seat must be the _only_ payer of a target — the DeFi executor and its
routers — the role carries `dedicatedPolicy`, and the plan emits a
`set-policy` step binding that seat to its own stack through
`EscalationRouter.setNodePolicy`.

## Flows bind at install time

Crew flows reference seats and targets by id, because a template cannot know an
address that only exists once the hire lands:

```ts
import { bindCrewFlow, crewFlowPlaceholders, getFlowTemplate } from "@lacrew/flows";

const def = getFlowTemplate("desk-execute-trade")!.definition;
crewFlowPlaceholders(def); // ["target.dex-router"]

bindCrewFlow(def, { targets: { "dex-router": "0x…" } });
bindCrewFlow(def, {}); // throws unbound_crew_placeholders: target.dex-router
```

Binding throws rather than leaving a placeholder in place: the run-time
interpolator renders an unknown reference as an empty string, and "delegate to
the risk manager" quietly becoming "delegate to ''" is not a failure anyone
would notice in time.

## The plan

`crewPlan(blueprint, bindings)` returns the ordered calls that stand a crew up —
hires down the tree, caps, policy bindings, whitelists, grants, flow installs.
It executes nothing. Each step carries:

- `via` + `tool` — the MCP tool (`lacrew_org_action`, `lacrew_set_budget`) or the
  orchestrator route (`POST /flows`) that carries it
- `tier` — the governance tier it rides when policy escalates it
- `pending` — the addresses still unbound, so a half-bound plan says so instead
  of inventing one

```bash
lacrew crews plan content-studio --out plan.json
```

## Reaching the outside world

A blueprint's flows do the crew's thinking; [connectors](./connectors.md) are
how they act. Each blueprint declares the connectors its flows call, and
`lacrew crews show <id>` prints them as the list to register before the crew can
do more than reason:

```
Connectors to register before the crew can work
  github  (github.get_pull_request, github.merge_pull_request)
```

`validateCrewBlueprint` rejects a blueprint whose flows call a route no declared
connector serves, and a crew that genuinely reaches nothing says so with an
empty list rather than by omission.

## A gate names a target; the session key must cover it

A run proposes through a session key, and the orchestrator issues that key
pinned to the org's configured spend target. `EscalationRouter` refuses a
propose against any other target with `SessionTargetDenied` — a revert, not a
verdict, so the run ends in `error` and no `onDeny` edge fires.

That is why a crew whose seats pay several targets needs the run's session
scoped to cover them, and why a flow that expects a refusal asks
`lacrew_check_policy` first instead of proposing and reading the verdict off the
failure. The check reads the policy stack directly: no session, no revert, a
real `ALLOW` / `ESCALATE` / `DENY` to branch on.

## The publish gate

The content studio's publishing endpoint is listed with `whitelisted: false`.
That is not an omission: the weekly pipeline asks policy about that target, gets
DENY, and routes to a step that assembles the human sign-off package. The gate
that would actually pay the publication fee sits behind that branch, reachable
only once the endpoint is admitted — a high-tier proposal, timelocked and
vetoable, visible to both human seats.

Verified on Anvil: `lacrew_check_policy` against an unadmitted endpoint returns
`{"verdict":"DENY"}`, the branch takes the false edge, and the run completes on
the sign-off step. "Never auto-publish" is a policy verdict, not a rule someone
remembered.

## The first run, on your own Anvil

A blueprint install ends with seats, budgets and flows and no evidence any of it
works. `crews checklist` closes that gap for a self-host: it probes a running
orchestrator for the seven things a first supervised action needs, and exits
non-zero while any of them is outstanding — so a script can gate on it.

Two blueprints are **certified**: they ship a run input the product will fire at
a crew nobody has finished configuring, and a driver that proves the path on a
local chain. `crewSampleRun` answers nothing for the rest, and every surface
says so rather than inventing an input.

| Blueprint        | Certified flow         | What its first run needs               | What it proves                                                   |
| ---------------- | ---------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `github-experts` | `bot-pr-triage`        | a model key and the `github` connector | a merge refused, because nothing admitted the merge authority    |
| `content-studio` | `content-weekly-brief` | a model key, and nothing else          | a publication refused, because the endpoint is off the whitelist |

```bash
ORCH_URL=http://127.0.0.1:8788 lacrew crews checklist github-experts
```

```
GitHub experts crew — first run  5/7
  probing http://127.0.0.1:8788 · thread crew:github-experts

  ✓ Seats
      1 of 6 seats have an account; the rest are still proposals.
  ✓ Orchestrator
      Running against a chain.
  ▲ Model provider
      No model key, so every completion returns a local stub. …
  ✓ Connector
      github is registered and credentialed.
  ✓ Flows
      All 3 of the blueprint's flows are installed.
```

Every line is derived from something the orchestrator already serves — its own
health, the connectors it has registered, the flows saved against it, the runs
recorded, the thread. Nothing is stored and nothing is marked done by hand, so
the list cannot go stale when a credential is later unset.

Four states, and `–` is the load-bearing one: "the orchestrator did not answer,
so we cannot say whether the connector is wired" is a third answer, and it is
neither a blocker nor a pass. `First run` and `Thread` never block the exit
code — they are the outcome the checklist drives at, and refusing on "nothing
has run yet" would refuse every first run there has ever been.

### Naming the seats

The chain stores addresses and reporting lines. It stores no role ids and no
names, so something off-chain has to remember that `reviewer` landed on `0x2b09…`
— otherwise a seat is found by matching a typed label against the blueprint's,
which works until somebody renames it.

The orchestrator keeps that mapping itself:

```bash
# Record what the hires landed on. --from-org reads the live chart and
# persists every seat a label still matches — do this while the labels
# and the blueprint still agree, which is right after the install.
lacrew crews bind github-experts --from-org

# Or say it outright, one seat at a time.
lacrew crews bind github-experts --bind reviewer=0x2b09… --bind fixer=0xFF31…

# What is stored, seat by seat.
lacrew crews bind github-experts
```

Bindings live in the orchestrator's own store (Postgres when `DATABASE_URL` is
set, memory otherwise) and are hydrated at boot, so they survive a restart and
they do not depend on the operator still having the plan file they installed
from. `GET /org` then carries a `roleId` on every seat that has one, which is
where `crews checklist`, `crews sample` and a flow install all read it.

`--bind` still works on `crews checklist`, and it **wins** over what the
orchestrator stored: it is the operator saying, right now, which account a seat
is on. An empty value on `crews bind` (`--bind reviewer=`) forgets a seat rather
than storing a blank address.

A bound seat resolves through its role id and survives any rename. A seat
nothing matched is **named**, never bound to a plausible-looking wrong address:
running a flow as the wrong principal gets the wrong policy stack, which is the
difference between a spend that escalates to a manager and one that should never
have been attempted. Two seats sharing a label bind neither, for the same
reason.

None of this is authority. A stored role id *finds* a seat whose readiness is
still derived live, every time; it admits no target, grants no budget and
approves no spend. That is also why an unreadable binding store is not an
outage: seats fall back to matching by label with the misses named, which is
exactly how a self-host behaved before the map existed.

The routes underneath, for a self-host driving the orchestrator directly:

| Route | What it does |
| --- | --- |
| `GET /crew/bindings[?blueprint=&crew=]` | the bindings in force, plus `roles` in the shape a flow install takes |
| `PUT /crew/bindings` | record `{blueprintId?, crewId?, roles, labels?}`; merges, and a blank address forgets one seat |

The hosted control plane stores the same mapping per crew and writes it through
to the tenant's orchestrator on install, so the two agree. Where they disagree,
the orchestrator is the source of truth — it is the process that will actually
run the flow as that principal — and the cloud says so rather than picking
silently.

### The whole path, checked

`pnpm golden-path` drives it end to end against a real chain, and is the answer
to "does the product work" that a unit test cannot give:

```bash
pnpm golden-path
```

It starts Anvil, deploys the reference contracts, boots an orchestrator on its
own port, and asserts that runtime is `onchain` before anything else runs — a
green path against a mocked runtime is the exact failure the golden path exists
to avoid. Then it hires two seats through real governance proposals, renames one
and proves it still resolves, registers the `github` preset against a local
stand-in for `api.github.com`, asks the deployed policy stack about the
merge-authority address the crew has not admitted (`DENY`), installs
`bot-pr-triage` bound to the addresses those hires minted, and runs the
checklist.

The stand-in host is the one fake, and it is the right one: the alternative is a
real token, a network round trip, and a public write path in CI. Everything
between the flow step and the socket — route resolution, path templating, the
credential header — is the production path.

A model key is optional. Without one, completions come back as the
orchestrator's stub, a classifier reading stub text falls through to its default
branch, and a run that "succeeded" would mean nothing — so the checklist blocks
on the model and the script asserts _that_. Set `OPENROUTER_API_KEY` (or any
provider key) and it drives the sample run itself, asserting the run was served
by the runtime rather than the mock backend, that it reached the connector, and
that it never merged.

### The second path, which never leaves LaCrew

```bash
pnpm golden-path --blueprint content-studio
```

The same driver, the same chain, one deliberate difference: the content studio's
weekly pipeline calls no connector route at all. So the run needs no credential
and no stand-in host, and the checklist answers the connector step **not
needed** rather than blocked — an answer a suite of GitHub-shaped verticals
would never reach, and the one an operator meets first if they start here.

What it refuses is a level up from a route. The pipeline asks
`lacrew_check_policy` about the publishing endpoint before it spends against it,
the deployed stack answers `DENY` because nothing admitted that address, and the
run assembles the human sign-off package instead of publishing. With a model key
the driver asserts exactly that: the `signoff` step ran, `publish` and
`published` did not.

Which seats to hire and which spend targets to bind are read off the sample
flow's own `{{crew.*}}` / `{{target.*}}` placeholders, so a template that gains
a delegate gains the hire in the same commit rather than leaving the driver
bound to a list somebody has to remember to update.

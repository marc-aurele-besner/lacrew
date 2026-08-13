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
the same fabrication one level down. The four DeFi patterns each ship at least
one, because there the pipeline _is_ the claim: "this crew can only advise" is
not a sentence in a summary, it is a policy check `lp-range-review` performs
against a router nobody admitted — and it is only checkable because the flow
runs it.

Each of the four is built around a different layer:

| Blueprint         | What it demonstrates                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lp-advisor`      | A crew with no execution authority at all. No venue and no payout target is admitted, so the advice is a property of the whitelist rather than a promise                                                               |
| `yield-desk`      | Admission as the risk control. It carries an unadmitted-market entry so the refusal path is exercised, and its allocator holds a dedicated stack because the org-wide whitelist admits a market for every seat at once |
| `risk-watch`      | Detection is not prevention. Every guardrail states its residual risk, not only the `monitoring` ones validation demands it of                                                                                         |
| `governance-desk` | An onchain action that moves no value. The cap, the whitelist and the allowance all answer ALLOW on a vote, and the blueprint says so instead of implying the policy stack covers it                                   |

`governance-desk` ships two flows rather than one, and the pair is the point.
`governance-vote-cycle` reasons about a proposal handed to it, which is right
when a human is already looking at one. `governance-proposal-sweep` starts from
a Snapshot space instead and finds the proposal itself — the difference between
a desk that watches a protocol and a desk that waits to be told. It ends in the
instruction a mandate owner casts, because a Snapshot vote is a message signed
by the delegate's key and no connector ships a route that could send one. See
[how discovery reaches a run](/docs/connectors#how-discovery-reaches-a-run).

## What a blueprint holds

```ts
import { getCrewBlueprint, crewPlan, validateCrewBlueprint } from "@lacrew/flows";

const bp = getCrewBlueprint("github-experts")!;
validateCrewBlueprint(bp); // { ok: true, errors: [] }
```

| Field                 | What it answers                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `roles`               | The org chart: kind, who it reports to, its charter, its per-call `capUsdc` and per-epoch `grantUsdc`                             |
| `targets`             | Where money may go, and which targets are deliberately **not** whitelisted                                                        |
| `externalScopes`      | Credentials LaCrew does not govern — a GitHub App, a draft-only social token                                                      |
| `externalSeats`       | Seats in **other** crews this one's flows may act on — see [crews that act on other crews](#crews-that-act-on-other-crews)        |
| `escalation`          | The "ask me first" ladder, and which layer carries each rung                                                                      |
| `governance`          | Which changes are constitutional, and at which tier                                                                               |
| `guardrails`          | Each "must never happen", its enforcement layer, and its residual risk                                                            |
| `recommendedControls` | Supervision the blueprint recommends — see [recommended supervision](#recommended-supervision). Offered at install, never implied |
| `outOfScope`          | What the crew deliberately does not do                                                                                            |

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

## Recommended supervision

Some guardrails are enforced by a control an operator has to _turn on_:
[plan-required](./plan-required.md) and [dual control](./dual-control.md). A
blueprint carries those as `recommendedControls`, so the recommendation is a
setting an install can apply rather than a sentence in a guardrail nobody reads.

```ts
recommendedControls: {
  planRequired: { scope: { level: "agent", role: "merger" }, mode: "side_effects", why: "…" },
  dualControl: { scope: { level: "crew" }, mode: "risky_writes", reviewer: "manager", why: "…" },
}
```

`scope` names a **role id**, not an address — bound at install like everything
else a blueprint references. `{ level: "crew" }` lands on the crew's own
manager, which is the node the runtime attributes the crew's work to; `agent`
lands on one seat. A `seat:<role>` reviewer binds the same way. `why` is
required: an install checkbox that could only say "apply recommended controls"
is an operator agreeing to something nobody explained.

Nothing here is applied unless it is asked for:

```bash
lacrew crews show github-experts       # what is recommended, and why
lacrew crews plan github-experts --apply-recommended-controls
```

The steps land **before** the flow installs, so a crew is never given work in a
window where the operator believes it is supervised and it is not. And no
recommended control ever widens anything: the caps, the whitelist, the ladder
and governance are identical either way — the strictest thing any of them can do
is make the crew wait.

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

## Crews that act on other crews

A blueprint may only bind seats it owns. `{{crew.executor}}` names a role in
_this_ blueprint, and validation rejects a placeholder naming anything else —
correctly, since the blueprint has no idea whether that role exists or who
holds it.

That leaves a real job unserved. `risk-watch` watches the protocols an org
already has money in, and the useful thing it can do about a depeg is stop the
seat that trades it — a seat belonging to the trading desk beside it. Handing
the address in as a run input made the crew's whole claim rest on a paste that
nothing checked.

An **external seat** is that reference, declared:

```ts
externalSeats: [
  {
    id: "desk-executor",
    label: "The desk seat this watch may halt",
    crewBlueprintId: "defi-desk",
    roleId: "executor",
    authority: "Deactivating the executor of the trading desk this watch was installed beside…",
  },
],
```

Flows bind it like any other reference — `{{external.desk-executor}}` — and
three rules keep it honest:

- A flow may only name a reference the blueprint declares, and a declared
  reference no flow names is rejected. Neither direction may drift.
- With the catalog in hand
  (`validateCrewBlueprint(bp, { crews: crewBlueprints })`), a reference naming a
  role its sibling blueprint does not have fails there, rather than at an
  install that cannot resolve it.
- A blueprint cannot name **itself** — a seat this crew owns binds as
  `{{crew.<roleId>}}`.

### Resolution fails closed

`resolveExternalSeats` turns a declaration into an address by looking up seats
the workspace already recorded — role id, the blueprint the crew was installed
from, the account its hire landed on. It never takes an address:

```ts
import { resolveExternalSeats, externalSeatRefusal } from "@lacrew/flows";

const resolved = resolveExternalSeats(bp, orchestratorBindings);
resolved.external; // { "desk-executor": "0x…" }
resolved.missing; // refs nothing bound — the install stops for these
resolved.ambiguous; // more than one candidate: nothing bound, on purpose
```

Nothing matched means the sibling crew is not installed (or its seat has not
landed). More than one match — two desks from the same blueprint — binds
nothing and asks the operator which crew, because picking one halts somebody at
random. Passing a choice narrows to that crew and only that crew; a stale pick
resolves to nothing rather than quietly retargeting the halt.

A declaration is not authority. Whoever installs the watch beside the desk is
the one handing over the ability to deactivate that seat, and the chain still
decides whether the deactivation lands — `risk-watch` treats it as a high-tier
governance change, so the desk keeps trading until somebody votes.

### The runtime refuses an unresolved reference

`bindCrewFlow` throws at install, and the runtime holds the same line: an `org`
or `budget` step whose `node`, `parent` or `target` still carries a
`{{crew.*}}` / `{{target.*}}` / `{{external.*}}` reference fails with
`unbound_crew_placeholder:<step>.<field>`. Interpolation would otherwise render
it as `""`, which is an account — and deactivating it is not a mistake to learn
about from a chain revert.

## The plan

`crewPlan(blueprint, bindings, options)` returns the ordered calls that stand a
crew up — hires down the tree, caps, policy bindings, whitelists, grants, the
[recommended controls](#recommended-supervision) when
`applyRecommendedControls` is set, and flow installs. It executes nothing. Each
step carries:

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

Four blueprints are **certified**: they ship a run input the product will fire
at a crew nobody has finished configuring, and a driver that proves the path on
a local chain. `crewSampleRun` answers nothing for the rest, and every surface
says so rather than inventing an input.

| Blueprint         | Certified flow              | What its first run needs                                     | What it proves                                                   |
| ----------------- | --------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `github-experts`  | `bot-pr-triage`             | a model key and the `github` connector                       | a merge refused, because nothing admitted the merge authority    |
| `content-studio`  | `content-weekly-brief`      | a model key, and nothing else                                | a publication refused, because the endpoint is off the whitelist |
| `governance-desk` | `governance-proposal-sweep` | a model key and the `snapshot` connector, which needs no key | a crew that finds its own work, and still cannot cast the vote   |
| `defi-desk`       | `desk-opportunity-scan`     | a model key, and nothing else                                | a trade refused at a venue nobody admitted, one seat down        |

The four are deliberately different shapes. `github-experts` needs a connector,
a credential and an admitted address. `content-studio` leaves LaCrew not at all,
so it drives the checklist's _connector not needed_ answer. `governance-desk`
needs a connector that costs nothing to wire, because the surface is public and
read-only — which makes it the cheapest of the four to actually run. `defi-desk`
is the only one whose certified run crosses a seat boundary: the seat that fires
it cannot spend at all, and the money path exists only in the run it delegates.

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

None of this is authority. A stored role id _finds_ a seat whose readiness is
still derived live, every time; it admits no target, grants no budget and
approves no spend. That is also why an unreadable binding store is not an
outage: seats fall back to matching by label with the misses named, which is
exactly how a self-host behaved before the map existed.

The routes underneath, for a self-host driving the orchestrator directly:

| Route                                   | What it does                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /crew/bindings[?blueprint=&crew=]` | the bindings in force, plus `roles` in the shape a flow install takes                          |
| `PUT /crew/bindings`                    | record `{blueprintId?, crewId?, roles, labels?}`; merges, and a blank address forgets one seat |

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

### The third path, whose connector costs nothing

```bash
pnpm golden-path --blueprint governance-desk
```

A connector again, but the opposite end of the setup burden from the first path:
the Snapshot hub is public, so the preset takes no credential, there is no
stand-in host, and the driver registers it against the real hub. The connector
step reaches **done** on a workspace where nobody has set a variable — which is
the answer that makes this the cheapest certified path to run for real.

Its refusal is the withdrawal address the blueprint deliberately leaves off the
whitelist: a proposal that would route funds to this org can be voted on, and
the funds cannot be received by this crew. The driver asks the deployed stack
about it and reads `DENY`. With a model key it also asserts where the run ended
— the `queue` step reached, and neither vote step touched, because casting a
Snapshot vote is a signed message this crew cannot produce.

Which seats to hire and which spend targets to bind are read off the certified
flow's own `{{crew.*}}` / `{{target.*}}` placeholders — and off the flows it
delegates to, since those bind addresses of their own — so a template that gains
a delegate gains the hire in the same commit rather than leaving the driver
bound to a list somebody has to remember to update.

### The fourth path, where the run changes seats

```bash
pnpm golden-path --blueprint defi-desk
```

The desk's certified run starts as the **market scanner**, and the scanner
cannot buy anything: its cap is 5 USDC and its seat holds no propose tool at
all. So the flow screens one candidate, writes the route plan, and delegates to
the **executor**, which is the seat carrying the desk's clip size. That delegate
runs under its own principal and its own policy stack — a flow cannot borrow
authority by handing work to a seat that has more of it.

That is why the driver installs `desk-execute-trade` alongside the certified
flow, and why the check that matters is on the child run rather than the one it
fired: the parent reports that it delegated, and the money would have moved in
the delegate. Nothing admitted the router address the executor's gate spends
against, so the propose comes back `DENY`, no receipt is filed, and the desk
paid nobody. The driver reads that child run off the run log and asserts exactly
that — the `trade` gate's verdict, and the `receipt` step that must not exist.

A trade the desk _has_ admitted a venue for is not automatically taken either.
Over the executor's clip size the propose escalates, the intent parks for the
risk manager onchain, and the run writes the memo they read before approving —
which the eval suite pins alongside the refusal
(`lacrew flows eval --blueprint defi-desk`).

### The cross-crew halt, checked

```bash
pnpm cross-crew-halt
```

The same shape for the claim in [crews that act on other
crews](#crews-that-act-on-other-crews): it hires a **desk** executor through
governance, records that seat on the orchestrator, and resolves `risk-watch`'s
`desk-executor` reference against what the orchestrator serves — no address is
typed anywhere in the driver. Before the desk seat exists, it asserts the
reference resolves to nothing, the flow refuses to install, and the checklist
blocks on the reference by name. Then it runs the real sweep and votes the
resulting proposal through, after which the chain itself reports that seat
inactive and every other seat untouched.

With no model key the assessment comes back as stub text, and `risk-sweep`
routes an unreadable assessment to the halt rather than past it — the
blueprint's own fail-closed guardrail, and what lets this run unattended.

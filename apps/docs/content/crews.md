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

| Blueprint | Vertical | Shape |
| --- | --- | --- |
| `defi-desk` | Trading | Scanner, planner, executor, rebalancer under a risk manager who can halt the desk |
| `github-experts` | Dev | Watcher, reviewer, merger, fixer, release scribe under a review lead |
| `content-studio` | Content | Ideation, writer, three-seat review board, visual packager, social desk under an editor manager |

## What a blueprint holds

```ts
import { getCrewBlueprint, crewPlan, validateCrewBlueprint } from "@lacrew/flows";

const bp = getCrewBlueprint("github-experts")!;
validateCrewBlueprint(bp); // { ok: true, errors: [] }
```

| Field | What it answers |
| --- | --- |
| `roles` | The org chart: kind, who it reports to, its charter, its per-call `capUsdc` and per-epoch `grantUsdc` |
| `targets` | Where money may go, and which targets are deliberately **not** whitelisted |
| `externalScopes` | Credentials LaCrew does not govern — a GitHub App, a draft-only social token |
| `escalation` | The "ask me first" ladder, and which layer carries each rung |
| `governance` | Which changes are constitutional, and at which tier |
| `guardrails` | Each "must never happen", its enforcement layer, and its residual risk |
| `outOfScope` | What the crew deliberately does not do |

### Enforcement layers

Every guardrail names where it is enforced, because a config that implies the
chain refuses something it has never seen is worse than no config:

| Layer | Meaning |
| --- | --- |
| `policy` | A policy module — cap, whitelist, rate limit, time window. DENY is final. |
| `treasury` | Allowance topology: seats spend their own stream, never the treasury. |
| `session` | The session key's own limits; the key cannot sign it at all. |
| `governance` | Proposal, quorum, and — at the high tier — timelock plus human veto. |
| `escalation` | The action waits for a manager or the human root. |
| `flow` | The pipeline's own routing. Real, but orchestrator-side. |
| `external` | A credential scoped outside LaCrew. |
| `monitoring` | Detected after the fact by Guardian. Not prevention — and a guardrail on this layer must state its residual risk, or validation rejects it. |

`validateCrewBlueprint` also rejects a manager whose cap is smaller than a
report's (the escalation would dead-end), a reporting cycle, a worker acting as
a parent, a seat spending on an unlisted target, a flow the blueprint does not
ship, and an escalation ladder that never reaches a human.

## Whitelists are org-wide

The default `WhitelistPolicy` allows a target for the whole org, not per seat.
A blueprint's `targets` are therefore an org-level answer, and `crewPlan` emits
one whitelist call per target rather than one per seat.

When a seat must be the *only* payer of a target — the DeFi executor and its
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

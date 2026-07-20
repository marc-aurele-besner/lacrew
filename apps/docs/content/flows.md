# Agent logic flows (`@lacrew/flows`)

Flows are declarative pipelines of agent logic — model calls, LaCrew tools,
policy-gated spends, and branches — that the orchestrator executes against its
live runtime. The same JSON definition powers the cloud's visual Flow Builder
(UX-first) and the code-first SDK path shown here, and the builder always
exposes the definition as both JSON and this exact TypeScript.

Flows never hold keys and never touch the treasury: every onchain effect is
policy-checked first and then either proposed as a spend intent or routed into
governance, so policy stacks, escalation, and the audit trail apply exactly as
they do for any other agent action.

## Step kinds

| Kind | What it does | Edges |
| --- | --- | --- |
| `model` | LLM completion via the orchestrator's `ModelProvider` | `next` |
| `tool` | LaCrew MCP tool call (org tree, pending intents, approve, …) | `next` |
| `gate` | Proposes a spend intent and branches on the policy verdict | `onAllow` / `onEscalate` / `onDeny` |
| `branch` | String/number condition on a prior output | `onTrue` / `onFalse` |
| `switch` | Multi-way match on a prior output | one edge per case / `onDefault` |
| `agent` | Delegates to another agent, under that agent's own policy | `next` |
| `org` | Hire, fire, reparent, activate, or change a cap / whitelist / policy | `onAllow` / `onEscalate` / `onDeny` |
| `budget` | Raise a grant, stream an allowance, run the next epoch | `onAllow` / `onEscalate` / `onDeny` |
| `governance` | Propose, vote, veto, or execute | `next` |

Prompts and string args interpolate `{{input}}`, `{{steps.<id>.text}}`,
`{{steps.<id>.json}}`, and `{{steps.<id>.verdict}}`. Steps fall through in
declaration order unless a step routes explicitly; `null` stops the flow.
Cycles are rejected — recurrence belongs to the trigger layer instead:

## Scope

A flow carries a `scope` that decides who can see and invoke it:

| Level | Visible to |
| --- | --- |
| `org` (default) | every node in the org |
| `team` | the node at `scope.ref` and everyone reporting under it |
| `agent` | the agent at `scope.ref`, plus its managers |

Scope is also a **policy ceiling**. A run always executes as its invoking
principal — never as the scope — so effective authority is
`min(principal, scope)`: both policy stacks are read and the stricter verdict
wins. An org-scoped flow invoked by a junior agent still only gets that agent's
authority, and an agent-scoped flow invoked by a manager is capped at the
scoped agent's limits.

### How the ceiling is enforced

For **spend value**, the ceiling is enforced onchain. Before a scoped run
proposes anything, the orchestrator issues that run a session key whose
`maxValue` is `min(principal cap, scope cap)`, read from `SpendCapPolicy`.
`EscalationRouter` checks every propose against the key's limits, so an
over-ceiling spend reverts with `SessionValueExceeded` — the chain refuses it,
not the orchestrator. Sessions are cached per `(agent, limits)`, so a wide key
issued for an unscoped run is never reused for a tighter-scoped one.

Other policy dimensions — rate limits, time windows — are **not** carried by the
session key. For those the ceiling remains an orchestrator-side check, and a
compromised orchestrator could skip it. The principal's own stack is still
enforced onchain in every case, which is the guarantee that protects the
treasury.

> **Trust boundary.** Session limits are only as strong as the issuer role.
> `SessionRegistry.issue` is root-or-issuer, and the orchestrator normally holds
> the issuer role, so a compromised orchestrator could mint itself a wider key.
> It cannot do so silently: every issue emits an onchain event, which Guardian
> can alert on and the root can revoke. Running the issuer as a separate key the
> orchestrator does not hold closes this gap.

## Constitutional steps

`org` and `budget` steps do not write directly. Org structure and treasury
grants are constitutional, and the orchestrator holds short-lived session keys
only — letting it rewrite the org chart would be exactly the custody LaCrew
refuses. So these steps always raise a **governance proposal**, and the policy
verdict picks the tier:

| Verdict | Result |
| --- | --- |
| `ALLOW` | low-tier proposal — executes on quorum, no timelock |
| `ESCALATE` | high-tier proposal — timelock plus human veto window |
| `DENY` | nothing is raised; the step routes to `onDeny` |

Authority is read from `SpendCapPolicy` rather than the full stack: the target
of an org action is a node, not a payee, so consulting `WhitelistPolicy` would
deny every such action for a reason unrelated to authority.

`budget: run-epoch` is the exception and writes directly — the orchestrator is
the `EpochStreamer` operator by design.

`org` distinguishes removal from suspension, because they are not the same
decision:

- `fire` → `OrgRegistry.removeNode`. Permanent, and the node's children are
  rewired to its parent.
- `deactivate` / `activate` → `OrgRegistry.setActive`. Reversible; the node
  keeps its place in the chart and its reporting line.

## Delegation

An `agent` step can hand work to another agent — a prompt, or a whole flow via
`flowId`. The nested run gets its own principal, so the delegate acts under its
*own* policy stack: a flow cannot borrow authority by invoking a more
privileged agent.

Delegation is bounded. `validateFlow` rejects cycles between a flow's own
edges, but a `flowId` is not an edge, so the runtime tracks the chain of flows
on the stack: revisiting one fails with `flow_delegation_cycle`, and a chain
deeper than four levels fails with `flow_delegation_too_deep`. A delegate that
fails also fails the delegating step, rather than returning the failure as data
for the parent to ignore.

## Triggers

`trigger: "manual"` (default) runs from the UI, SDK, or CLI. `trigger:
"epoch"` turns the pipeline into an automation: the orchestrator fires it on
every payroll epoch, right after allowances stream (both the queue schedule
and `POST /epoch` do this, and the run is tagged `trigger: "epoch"` in the
trace and audit trail). The shipped `treasury-pulse` template is
epoch-triggered out of the box.

## Persistence

Definitions and run traces persist to Postgres when `DATABASE_URL` is set
(`orchestrator_flows` / `orchestrator_flow_runs`, same `@lacrew/db` family as
the audit trail) and hydrate back on boot; without a database everything
still works in memory. `/health` reports which store is active under
`flows.store`.

## Code-first

```ts
import { flow, createFlowsClient } from "@lacrew/flows";

const budgetGuardedSpend = flow("budget-guarded-spend", "Budget-guarded spend")
  .gate("spend", {
    value: "75000000", // 75 USDC (6dp)
    onAllow: "confirm",
    onEscalate: "po-note",
  })
  .model("confirm", {
    prompt: "Spend allowed: {{steps.spend.json}}. Write a one-line receipt.",
    next: null,
  })
  .model("po-note", {
    prompt: "Spend escalated: {{steps.spend.json}}. Draft the purchase-order note.",
    next: null,
  })
  .build();

const flows = createFlowsClient({
  baseUrl: process.env.ORCH_URL ?? "http://127.0.0.1:8788",
  token: process.env.ORCH_TOKEN, // pairs with LACREW_ORCH_TOKEN
});

await flows.save(budgetGuardedSpend);
const run = await flows.run("budget-guarded-spend", { input: "manual run" });
console.log(run.status, run.steps.map((s) => s.summary));
```

`runFlow(def, backend)` executes a definition in-process against any
`FlowBackend`; `createMockFlowBackend()` is the detached offline fallback the
tests and demos use. Pass `onStep` to observe progress live:

```ts
await runFlow(def, backend, {
  input: "manual run",
  onStep: (t) => console.log(t.stepId, t.verdict ?? t.status, t.summary),
});
```

## CLI

```
lacrew flows templates                  # built-in catalog (offline)
lacrew flows run treasury-pulse --local # offline mock run with live trace
lacrew flows run my-flow --input "hi"   # run on the orchestrator (ORCH_URL/ORCH_TOKEN)
lacrew flows save my-flow.json          # validate + persist
lacrew flows runs                       # recent traces, newest first
lacrew flows code tpl-content-daily     # print the code-first snippet
```

## Orchestrator HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /flows` | List saved definitions |
| `POST /flows` | Save (validates; body `{ flow }`) |
| `POST /flows/delete` | Remove (body `{ id }`) |
| `POST /flows/run` | Run by `{ id }` or inline `{ flow }`, optional `input` |
| `GET /flows/runs` | Recent run traces (newest first) |
| `GET /flows/templates` | First-party template catalog |

Every save and run lands in the audit trail as `FlowSaved` / `FlowRun` events.

## LangChain

`@lacrew/adapter-agents-langchain` bridges both directions without a hard
`langchain` dependency:

```ts
import {
  createLacrewLangChainTools,
  createLangChainFlowBackend,
} from "@lacrew/adapter-agents-langchain";

// LangChain agent → LaCrew: policy-checked tools for any LangChain agent.
// Each entry maps onto new DynamicStructuredTool({ name, description, schema, func: invoke }).
const tools = createLacrewLangChainTools({ backend: "http://127.0.0.1:8788" });

// LaCrew flow → LangChain: any runnable (chain, chat model, agent executor)
// becomes the model side of a FlowBackend; tool/gate steps stay policy-checked.
import { runFlow } from "@lacrew/flows";
const backend = createLangChainFlowBackend({ runnable: myChain });
const result = await runFlow(budgetGuardedSpend, backend);
```

## Scope

A flow carries a `scope` that decides who can see and invoke it:

| Level | Visible to |
| --- | --- |
| `org` (default) | every node in the org |
| `team` | the node at `scope.ref` and everyone reporting under it |
| `agent` | the agent at `scope.ref`, plus its managers |

Scope is also a **policy ceiling**. A run always executes as its invoking
principal — never as the scope — so effective authority is
`min(principal, scope)`: both policy stacks are read and the stricter verdict
wins. An org-scoped flow invoked by a junior agent still only gets that agent's
authority, and an agent-scoped flow invoked by a manager is capped at the
scoped agent's limits.

> The ceiling is enforced by the orchestrator. The chain independently enforces
> the invoking principal's own policy stack, which is the guarantee that
> actually protects the treasury: a compromised orchestrator can ignore a
> flow's scope cap, but never the principal's policy.

## Constitutional steps

`org` and `budget` steps do not write directly. Org structure and treasury
grants are constitutional, and the orchestrator holds short-lived session keys
only — letting it rewrite the org chart would be exactly the custody LaCrew
refuses. So these steps always raise a **governance proposal**, and the policy
verdict picks the tier:

| Verdict | Result |
| --- | --- |
| `ALLOW` | low-tier proposal — executes on quorum, no timelock |
| `ESCALATE` | high-tier proposal — timelock plus human veto window |
| `DENY` | nothing is raised; the step routes to `onDeny` |

Authority is read from `SpendCapPolicy` rather than the full stack: the target
of an org action is a node, not a payee, so consulting `WhitelistPolicy` would
deny every such action for a reason unrelated to authority.

`budget: run-epoch` is the exception and writes directly — the orchestrator is
the `EpochStreamer` operator by design.

`org` distinguishes removal from suspension, because they are not the same
decision:

- `fire` → `OrgRegistry.removeNode`. Permanent, and the node's children are
  rewired to its parent.
- `deactivate` / `activate` → `OrgRegistry.setActive`. Reversible; the node
  keeps its place in the chart and its reporting line.

## Delegation

An `agent` step can hand work to another agent — a prompt, or a whole flow via
`flowId`. The nested run gets its own principal, so the delegate acts under its
*own* policy stack: a flow cannot borrow authority by invoking a more
privileged agent.

Delegation is bounded. `validateFlow` rejects cycles between a flow's own
edges, but a `flowId` is not an edge, so the runtime tracks the chain of flows
on the stack: revisiting one fails with `flow_delegation_cycle`, and a chain
deeper than four levels fails with `flow_delegation_too_deep`. A delegate that
fails also fails the delegating step, rather than returning the failure as data
for the parent to ignore.

## Triggers

Flows fire three ways: `manual` (default), `epoch` (after every payroll
stream, even in mock mode), or `cron` with a 5-field UTC `schedule`
expression (`*/5 * * * *` style — minute resolution, fired at most once per
matching minute by the orchestrator's provider-agnostic scheduler):

```json
{ "trigger": "cron", "schedule": "0 9 * * 1-5" }
```

## Templates and the marketplace

`flowTemplates` ships first-party starters (treasury pulse, budget-guarded
spend, escalation triage, content crew daily). The cloud's marketplace surface
lists these today; third-party listings are mocked until the Phase 3
ecosystem work lands.

## Scaffold a crew project

`lacrew scaffold <template>` turns any template into a standalone runnable
project — `package.json`, `crew.ts`, the flow JSON, `.env.example`, README:

```bash
lacrew scaffold treasury-pulse --dir my-crew
cd my-crew && pnpm install && pnpm start   # offline mock run, full step trace
# set ORCH_URL (+ ORCH_TOKEN) to save + run on a live orchestrator instead
```

Inside a lacrew checkout the generated project links `@lacrew/flows` via
`file:`; elsewhere it pins the npm name (publish pending).

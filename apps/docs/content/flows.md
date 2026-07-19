# Agent logic flows (`@lacrew/flows`)

Flows are declarative pipelines of agent logic — model calls, LaCrew tools,
policy-gated spends, and branches — that the orchestrator executes against its
live runtime. The same JSON definition powers the cloud's visual Flow Builder
(UX-first) and the code-first SDK path shown here, and the builder always
exposes the definition as both JSON and this exact TypeScript.

Flows never hold keys and never touch the treasury: every onchain effect goes
through `lacrew_propose_intent`, so policy stacks, escalation, and the audit
trail apply exactly as they do for any other agent action.

## Step kinds

| Kind | What it does | Edges |
| --- | --- | --- |
| `model` | LLM completion via the orchestrator's `ModelProvider` | `next` |
| `tool` | LaCrew MCP tool call (org tree, pending intents, approve, …) | `next` |
| `gate` | Proposes a spend intent and branches on the policy verdict | `onAllow` / `onEscalate` / `onDeny` |
| `branch` | String/number condition on a prior output | `onTrue` / `onFalse` |

Prompts and string args interpolate `{{input}}`, `{{steps.<id>.text}}`,
`{{steps.<id>.json}}`, and `{{steps.<id>.verdict}}`. Steps fall through in
declaration order unless a step routes explicitly; `null` stops the flow.
Cycles are rejected — recurrence belongs to the trigger layer instead:

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

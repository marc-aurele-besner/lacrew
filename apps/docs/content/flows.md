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

| Kind         | What it does                                                         | Edges                               |
| ------------ | -------------------------------------------------------------------- | ----------------------------------- |
| `model`      | LLM completion via the orchestrator's `ModelProvider`                | `next`                              |
| `tool`       | LaCrew MCP tool call (org tree, pending intents, approve, …)         | `next`                              |
| `gate`       | Proposes a spend intent and branches on the policy verdict           | `onAllow` / `onEscalate` / `onDeny` |
| `branch`     | String/number condition on a prior output                            | `onTrue` / `onFalse`                |
| `switch`     | Multi-way match on a prior output                                    | one edge per case / `onDefault`     |
| `agent`      | Delegates to another agent, under that agent's own policy            | `next`                              |
| `org`        | Hire, fire, reparent, activate, or change a cap / whitelist / policy | `onAllow` / `onEscalate` / `onDeny` |
| `budget`     | Raise a grant, stream an allowance, run the next epoch               | `onAllow` / `onEscalate` / `onDeny` |
| `governance` | Propose, vote, veto, or execute                                      | `next`                              |
| `human`      | **Stops** the run until a person picks an option                     | one port per option / `timeoutPort` |
| `wait`       | Parks the run until a human or an event releases it                  | `next`                              |

Prompts and string args interpolate `{{input}}`, `{{steps.<id>.text}}`,
`{{steps.<id>.json}}`, and `{{steps.<id>.verdict}}`. Steps fall through in
declaration order unless a step routes explicitly; `null` stops the flow.
Cycles are rejected — recurrence belongs to the trigger layer instead:

## Scope

A flow carries a `scope` that decides who can see and invoke it:

| Level           | Visible to                                              |
| --------------- | ------------------------------------------------------- |
| `org` (default) | every node in the org                                   |
| `team`          | the node at `scope.ref` and everyone reporting under it |
| `agent`         | the agent at `scope.ref`, plus its managers             |

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

| Verdict    | Result                                               |
| ---------- | ---------------------------------------------------- |
| `ALLOW`    | low-tier proposal — executes on quorum, no timelock  |
| `ESCALATE` | high-tier proposal — timelock plus human veto window |
| `DENY`     | nothing is raised; the step routes to `onDeny`       |

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
_own_ policy stack: a flow cannot borrow authority by invoking a more
privileged agent.

Delegation is bounded. `validateFlow` rejects cycles between a flow's own
edges, but a `flowId` is not an edge, so the runtime tracks the chain of flows
on the stack: revisiting one fails with `flow_delegation_cycle`, and a chain
deeper than four levels fails with `flow_delegation_too_deep`. A delegate that
fails also fails the delegating step, rather than returning the failure as data
for the parent to ignore.

## Triggers

`trigger: "manual"` (default) runs from the UI, SDK, or CLI. `trigger:
"webhook"` makes the flow startable by a signed HTTP delivery (see
[Webhook triggers](#webhook-triggers)). `trigger:
"epoch"` turns the pipeline into an automation: the orchestrator fires it on
every payroll epoch, right after allowances stream (both the queue schedule
and `POST /epoch` do this, and the run is tagged `trigger: "epoch"` in the
trace and audit trail). The shipped `treasury-pulse` template is
epoch-triggered out of the box.

## Persistence

Definitions and run traces persist to Postgres when `DATABASE_URL` is set
(`orchestrator_flows` / `orchestrator_flow_runs`, plus
`orchestrator_webhook_triggers` / `orchestrator_webhook_deliveries` — same
`@lacrew/db` family as the audit trail) and hydrate back on boot; without a database everything
still works in memory. `/health` reports which store is active under
`flows.store`.

## Run lifecycle — pause, resume, cancel

A run outlives the process that started it. After **every completed step** the
orchestrator writes a checkpoint — the cursor, the outputs so far, the run's
principal and input — to `orchestrator_flow_checkpoints`, and moves the run's
cursor in `orchestrator_flow_run_state`, both in one transaction. A run can
therefore stop and be picked back up later, by a different replica.

| Status      | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `running`   | In flight                                                     |
| `waiting`   | **Paused** — parked and resumable                             |
| `completed` | Finished                                                      |
| `error`     | Failed                                                        |
| `cancelled` | Ended by an operator; **never** resumable                     |

A run pauses in four ways: a `wait` step it declared, a `human` gate holding it
until someone decides, an `ask`-mode connector write waiting on a human
([connectors](./connectors.md)), or an operator asking for a pause.
`waiting.reason` says which — `awaiting_human`, `awaiting_webhook`,
`human_gate`, `connector_ask`, or `operator`.

```ts
const flows = createFlowsClient({ baseUrl, token });

await flows.pauseRun(runId, "checking something"); // honoured at the next step
const finished = await flows.resumeRun(runId); // continues from the checkpoint
await flows.cancelRun(runId, "not doing it"); // terminal
```

Pause and cancel are **requests**, not mutations: the run may be moving inside
another replica, and the only safe place to honour one is between two steps —
never inside a write that is already in the air. A cancelled run asked to
resume answers `409 run_cancelled`.

### No double write on resume

Before every side-effecting step (`gate`, `org`, `budget`, `governance`,
`agent`, and any connector route) the orchestrator opens an **attempt** record,
and closes it once the call returns. A process that dies in between leaves the
attempt open, which is the one state that means "this write may already have
happened".

On boot the orchestrator reads back every unfinished run and:

- **resumes** runs that stopped cleanly between two steps — the steps that
  already ran are not repeated;
- **fails closed** on a run with an open attempt, naming the step and the
  attempt key to reconcile against. It is not retried, because redoing it could
  pay twice and skipping it could skip a payment, and only a human knows which
  happened;
- **leaves paused runs alone** — they are waiting on something, not stalled.

A step whose repeat is genuinely harmless can opt into the retry:

```ts
flow("pr-triage", "PR triage")
  .tool("merge", "github.merge_pull_request", { number: "7" }, { idempotent: true })
  .build();
```

`idempotent` is off by default and is a claim about the far side of the call
that LaCrew cannot check — untrue, it is a double spend.

Pausing an **agent** (`POST /agents/pause`) cancels that agent's parked runs
with the reason attached: a paused agent should spend nothing, and a resumable
run is authority waiting to be spent. Resuming a run always uses the run's
original principal and scope, so a pause can never launder authority.

## Blocking human gates

A `human` step is the one that says "a person decides before the rest of this
runs". Entering it posts **one** question into the run's thread, parks the run
on the durable state above, and goes no further. When someone answers with one
of the offered options, the run resumes down that option's port.

```ts
flow("shortlist", "Publish the shortlist")
  .model("draft", { prompt: "Draft a shortlist from {{input}}", next: "signoff" })
  .human("signoff", {
    prompt: "Publish this shortlist?\n{{steps.draft.text}}",
    options: [
      { id: "yes", label: "Publish", port: "publish" },
      { id: "no", label: "Skip", port: "memo" },
    ],
    timeoutMs: 4 * 60 * 60 * 1000,
    timeoutPort: "memo",
  })
  .tool("publish", "typefully.create_draft", { content: "{{steps.draft.text}}" }, { next: null })
  .model("memo", { prompt: "Record that nothing was published.", next: null })
  .build();
```

The rules the step enforces:

- **Exactly one question per run**, whatever happens. The gate is keyed by the
  run and the step, so a resume — or a second replica picking the run up —
  finds the question that is already open instead of asking again.
- **Only the listed options resolve it.** "sure, go ahead" decides nothing: the
  question is re-posted and the run stays parked, because a guess here publishes
  something nobody chose.
- **Only a human answers.** The author is resolved server-side when the message
  is posted; an agent replying `yes` in its own thread leaves the gate open and
  lands on the audit trail (`HumanGateUnresolved`).
- **A timeout fails closed.** With a `timeoutPort` the run takes that branch;
  without one it stops. Nobody answering is never read as a yes. The deadline
  comes from `timeoutMs` (minimum 5 minutes) or `LACREW_HUMAN_GATE_TTL_MS`
  (default a day), and the sweep that expires it runs once a minute on the
  queue, so exactly one replica times each gate out.
- **A cancelled run closes its gate.** A late answer then lands on a closed
  question rather than restarting a run the operator ended.

A gate is **control, not authority**. It releases a pipeline the running
principal was already allowed to execute — it approves no spend, changes no
policy, and signs nothing onchain. A spend downstream of a gate still meets the
policy stack and the escalation path exactly as it would have without one; if
money moves, an onchain `gate` step and the Approvals path are still what decide
it.

Open gates are readable at `GET /flows/gates?status=pending` (`lacrew flows
gates`), and answered in the thread:

```
POST /messages {"thread":"agent:0x…","replyTo":"<questionId>","kind":"answer",
                "authorKind":"human","body":"yes"}
```

There is deliberately no route that resolves a gate directly: a second way in
would be one the conversation never gets to attribute to a seat. Every gate
emits `HumanGateOpened`, then `HumanGateResolved` or `HumanGateTimedOut`, with
the run and question ids — never the rendered prompt, which can name a private
repo or a counterparty.

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
    prompt:
      "Spend escalated: {{steps.spend.json}}. Draft the purchase-order note.",
    next: null,
  })
  .build();

const flows = createFlowsClient({
  baseUrl: process.env.ORCH_URL ?? "http://127.0.0.1:8788",
  token: process.env.ORCH_TOKEN, // pairs with LACREW_ORCH_TOKEN
});

await flows.save(budgetGuardedSpend);
const run = await flows.run("budget-guarded-spend", { input: "manual run" });
console.log(
  run.status,
  run.steps.map((s) => s.summary),
);
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
lacrew flows open                       # runs still going or parked on something
lacrew flows pause <runId>              # stop at the next step boundary
lacrew flows resume <runId>             # continue from the last checkpoint
lacrew flows cancel <runId>             # end it for good (never resumable)
lacrew flows code tpl-content-daily     # print the code-first snippet
```

## Orchestrator HTTP surface

| Route                            | Purpose                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /flows`                     | List saved definitions                                                             |
| `POST /flows`                    | Save (validates; body `{ flow }`)                                                  |
| `POST /flows/delete`             | Remove (body `{ id }`)                                                             |
| `POST /flows/run`                | Run by `{ id }` or inline `{ flow }`, optional `input`                             |
| `GET /flows/runs`                | Recent run traces (newest first)                                                   |
| `GET /flows/runs/open`           | Runs still in flight or paused (the stalled-run list)                              |
| `GET /flows/runs/state`          | One run's state + checkpoint trail (`?runId=`)                                     |
| `POST /flows/runs/pause`         | Ask a run to stop at its next step (body `{ runId, reason? }`)                      |
| `POST /flows/runs/resume`        | Continue a paused run (body `{ runId }`); `409` if cancelled                        |
| `POST /flows/runs/cancel`        | End a run for good (body `{ runId, reason? }`)                                      |
| `GET /flows/templates`           | First-party template catalog                                                       |
| `GET /flows/triggers`            | Registered webhook triggers (never the secret)                                     |
| `POST /flows/triggers`           | Mint one (body `{ flowId, principal?, scheme?, input? }`); returns the secret once |
| `POST /flows/triggers/rotate`    | New secret (body `{ id }`); the old one stops verifying                            |
| `POST /flows/triggers/enabled`   | Enable / disable (body `{ id, enabled }`)                                          |
| `POST /flows/triggers/delete`    | Remove (body `{ id }`)                                                             |
| `GET /flows/triggers/deliveries` | Delivery log (`?triggerId=`, `?limit=`)                                            |
| `POST /hooks/:triggerId`         | Signed delivery — HMAC, not the bearer token                                       |

Every save and run lands in the audit trail as `FlowSaved` / `FlowRun` events,
and a pause / resume / cancel as `FlowRunLifecycle`;
trigger changes and accepted deliveries land as `WebhookTriggerChanged` /
`WebhookDelivery`.

`POST /hooks/:triggerId` is the one route outside `LACREW_ORCH_TOKEN`, because
its caller is an external producer holding the trigger's HMAC secret rather
than the operator's bearer token. It is not an unauthenticated route — every
request is verified against that signature and an unsigned one is refused.

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

| Level           | Visible to                                              |
| --------------- | ------------------------------------------------------- |
| `org` (default) | every node in the org                                   |
| `team`          | the node at `scope.ref` and everyone reporting under it |
| `agent`         | the agent at `scope.ref`, plus its managers             |

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

| Verdict    | Result                                               |
| ---------- | ---------------------------------------------------- |
| `ALLOW`    | low-tier proposal — executes on quorum, no timelock  |
| `ESCALATE` | high-tier proposal — timelock plus human veto window |
| `DENY`     | nothing is raised; the step routes to `onDeny`       |

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
_own_ policy stack: a flow cannot borrow authority by invoking a more
privileged agent.

Delegation is bounded. `validateFlow` rejects cycles between a flow's own
edges, but a `flowId` is not an edge, so the runtime tracks the chain of flows
on the stack: revisiting one fails with `flow_delegation_cycle`, and a chain
deeper than four levels fails with `flow_delegation_too_deep`. A delegate that
fails also fails the delegating step, rather than returning the failure as data
for the parent to ignore.

## Triggers

Flows fire four ways: `manual` (default), `epoch` (after every payroll
stream, even in mock mode), `cron` with a 5-field UTC `schedule`
expression (`*/5 * * * *` style — minute resolution, fired at most once per
matching minute by the orchestrator's provider-agnostic scheduler), or
`webhook` — a signed HTTP delivery from outside the org:

```json
{ "trigger": "cron", "schedule": "0 9 * * 1-5" }
```

A flow can also be run by a **crew heartbeat** without declaring anything: a
heartbeat works through a checklist an operator wrote, so the flow's own trigger
is irrelevant to it and a definition cannot opt into being on one. Those runs are
tagged `trigger: "heartbeat"` — see [Crew heartbeat](./heartbeat.md) for when to
reach for one instead of a per-flow cron.

## Webhook triggers

A `webhook` flow is started by a signed HTTP delivery, so a crew can react to a
PR opening or a post publishing instead of waiting for a human to press Run.

The declaration and the credential live in different places on purpose. The
flow definition says `"trigger": "webhook"` — that is what makes it externally
startable, and it travels with the definition through export and the
marketplace. The _trigger record_ — id, secret, principal, input mapping — is
held by the orchestrator, because a secret inside a shareable definition would
leak with every copy.

### Registering a trigger

```bash
curl -X POST "$ORCH/flows/triggers" \
  -H "authorization: Bearer $LACREW_ORCH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
        "flowId": "pr-triage",
        "principal": "0xWorkerAgent",
        "scheme": "lacrew",
        "input": { "fields": { "pr": "pull_request.number", "title": "pull_request.title" } }
      }'
```

The response carries the secret **once**:

```json
{
  "trigger": { "id": "wht_…", "secretVersion": 1 },
  "secret": "…",
  "secretShownOnce": true
}
```

There is no route that reads it back. Lose it and rotate
(`POST /flows/triggers/rotate`), which invalidates the previous secret
immediately.

Secrets are sealed at rest with the same AES-256-GCM envelope as session keys
(`LACREW_SESSION_KEY`). With `DATABASE_URL` set and no sealing key configured,
minting a trigger fails with `webhook_sealing_unavailable` rather than writing
a cleartext secret to Postgres.

### Event sources

`scheme` picks how a delivery proves it is genuine, which delivery it is, what
happened, and where the payload lives. Providers differ on all four:

| Source | Authenticates with | Idempotency key | Event type |
| --- | --- | --- | --- |
| `lacrew` (default) | HMAC over `<unix-seconds>.<body>` | `Idempotency-Key` | — |
| `github` | HMAC over the body | `X-GitHub-Delivery` | `X-GitHub-Event` + body `action` |
| `google-pubsub` | Google-signed OIDC token — **no shared secret** | Pub/Sub `messageId` | `message.attributes.eventType` |


### Signing a delivery

Two schemes, picked at registration:

| Scheme             | Header                              | Signed material                                                          |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------ |
| `lacrew` (default) | `X-Lacrew-Signature: sha256=<hex>`  | `<unix-seconds>.<raw body>`, with the same value in `X-Lacrew-Timestamp` |
| `github`           | `X-Hub-Signature-256: sha256=<hex>` | the raw body alone — what GitHub sends                                   |

The `lacrew` scheme signs the timestamp too, so a captured delivery cannot be
replayed once it drifts past the tolerance window (300s;
`LACREW_WEBHOOK_TOLERANCE_SEC`). The `github` scheme has no timestamp to sign,
so replay protection there rests entirely on the `X-GitHub-Delivery`
idempotency key — a property of the producer, not something the scheme asserts.

```bash
BODY='{"pull_request":{"number":7,"title":"Add hooks"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

curl -X POST "$ORCH/hooks/$TRIGGER_ID" \
  -H 'content-type: application/json' \
  -H "X-Lacrew-Timestamp: $TS" \
  -H "X-Lacrew-Signature: sha256=$SIG" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "$BODY"
```

A verified delivery answers `202 { "accepted": true, "runId": "run-wh-…" }`
and the run happens on a queue worker. The producer's socket is never what
keeps a funded run alive — a flow that takes minutes of model time would
otherwise be retried by every sane webhook sender while it was still working.

### Filtering events

A trigger with no `events` runs on every delivery. Naming them subscribes:

```json
{ "events": ["pull_request", "release.published"] }
```

Matching is by dotted prefix, so `pull_request` covers `pull_request.opened`
without listing each action — but only in that direction: a filter for
`pull_request.opened` is *not* satisfied by a bare `pull_request`.

An unsubscribed delivery answers `200 { "skipped": "event_not_selected" }`, not
a 4xx. GitHub disables a hook that keeps erroring, and "not interested" is not a
delivery failure. The skip is recorded in the delivery log with the event type,
so a quiet hook can be told apart from a broken one.

A delivery whose type the provider never declared always passes the filter:
"I could not tell what this was" is not "you did not ask for this".

### Wiring GitHub

Point a repository webhook (or a `repository_dispatch`) at
`$ORCH/hooks/<triggerId>`, set its secret to the trigger's secret, choose
_application/json_, and register the trigger with `"scheme": "github"`. GitHub's
`X-GitHub-Delivery` header is picked up as the idempotency key automatically, so
its redeliveries answer `200 duplicate` rather than starting a second run.

### Google Pub/Sub push (Gmail, Calendar, Drive)

Pub/Sub push does not sign the body — it authenticates the *sender*, with a
Google-signed OIDC token in `Authorization: Bearer`. There is no shared secret,
so the trigger binds to what it will accept instead:

```bash
curl -X POST "$ORCH/flows/triggers" \
  -H "authorization: Bearer $LACREW_ORCH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
        "flowId": "inbox-triage",
        "scheme": "google-pubsub",
        "config": {
          "audience": "https://orch.example.com/hooks/PLACEHOLDER",
          "serviceAccountEmail": "pusher@my-project.iam.gserviceaccount.com"
        },
        "input": { "fields": { "mailbox": "emailAddress", "historyId": "historyId" } }
      }'
```

Both `audience` and `serviceAccountEmail` are **required**, and refused at
creation rather than discovered on the first live event. This is the part that
makes the source safe: anyone can have Google mint a valid token for their own
service account and point their own subscription at your URL, so a signature
proving only "Google signed this" authorizes nothing. The audience you
configured plus the service account you expect are the binding.

The envelope is unwrapped before mapping. Pub/Sub delivers
`{ "message": { "data": "<base64>", "messageId": "…" } }` and the flow's input
mapping sees the *decoded* message — mapping `emailAddress` against the envelope
would read nothing and look like a typo rather than an unreachable path.
`messageId` becomes the idempotency key.

Google's signing keys come from their JWKS endpoint and are cached. An
unreachable key set answers `503` (retrying helps); a key absent from a current
key set answers `401` (it will not).


### Input mapping

The flow's `input` is a string. Without a mapping the whole body is passed
through as JSON, which makes `{{input}}` and top-level `{{input.action}}`
available. `fields` builds a flat object from dot paths — flat because
`{{input.x}}` only reaches the top level, so a nested passthrough would render
as an empty string and read like a missing field rather than an unreachable
one. `path` lifts a single value:

```json
{ "input": { "fields": { "pr": "pull_request.number" } } }
{ "input": { "path": "pull_request.title" } }
```

### From the CLI

All of this is also `lacrew flows triggers`, so a self-hosted operator never has
to hand-roll a signature:

```bash
lacrew flows triggers create --flow pr-triage --source github \
  --events pull_request --field pr=pull_request.number --field title=pull_request.title
lacrew flows triggers list
lacrew flows triggers curl <triggerId>       # a runnable signing example
lacrew flows triggers deliveries <triggerId>
lacrew flows triggers rotate <triggerId>
```


### What a hook does not grant

A webhook decides _who may start_ a flow. It never widens what the flow may
do: the run executes as the trigger's principal down the same path as a manual
run, so the principal's policy stack, its session key's onchain ceiling, and
its pause state all still apply. A gate inside a webhook-started flow escalates
to Approvals exactly as it would otherwise.

### Failure modes

| Condition                                    | Status | Error                                                     |
| -------------------------------------------- | ------ | --------------------------------------------------------- |
| Unknown trigger id                           | 404    | `webhook_trigger_not_found`                               |
| Missing / malformed / wrong signature        | 401    | `webhook_signature_missing` \| `_malformed` \| `_invalid` |
| Timestamp outside the tolerance window       | 401    | `webhook_timestamp_stale`                                 |
| Trigger disabled                             | 403    | `webhook_trigger_disabled`                                |
| Principal paused                             | 403    | `webhook_principal_paused`                                |
| Body over 1 MiB (`LACREW_WEBHOOK_MAX_BYTES`) | 413    | `webhook_body_too_large`                                  |
| Body is not JSON                             | 400    | `webhook_body_invalid`                                    |
| Delivery key already seen                    | 200    | `{ "duplicate": true }`                                   |
| Event type not subscribed | 200 | `{ "skipped": "event_not_selected" }` |
| Pub/Sub token for another audience or service account | 401 | `webhook_token_audience_invalid` \| `_email_invalid` |
| Google's key set unreachable | 503 | `webhook_jwks_unavailable` |

A paused principal is _rejected_ rather than skipped: a webhook producer
retries, and a silent skip would let a paused agent's events vanish behind a
2xx on every one of them.

Rejections are logged to the trigger's delivery log under their own key, never
the producer's — a rejected delivery established no idempotency, and reusing
its key would make the correctly-signed retry look like a replay of the
failure and get dropped. The log records the reason code, the byte count and
the run id; never the request body, which is attacker-supplied and routinely
full of someone else's personal data.

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

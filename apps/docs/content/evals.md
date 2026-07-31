# Flow & blueprint evals

> A blueprint's guarantees live in the edges of a flow. An eval is what holds
> them there when someone edits the flow.

A [crew blueprint](./crews.md) makes claims: _the advisory desk cannot trade_,
_merging needs an admitted authority_, _publishing is refused by construction_.
Those claims are not enforced by the prose — they are enforced by which port a
run takes and which connector route it calls. Editing a template, an
interpolated argument, or a connector preset can re-introduce a write on `DENY`
without a single unit test going red, because the definition still validates.

An **eval** is a scenario: golden input, mocked connectors and models, and
assertions about what the run actually did.

```bash
lacrew flows eval                    # the whole suite, offline
lacrew crews eval github-experts     # one crew's scenarios
lacrew flows eval --list             # what ships, without running it
```

It exits non-zero on any failure, so a self-hosted operator can wire it into
their own CI exactly as LaCrew does.

## What an eval is not

- **Not a model quality score.** There is no LLM-as-judge here. Model replies
  are scripted, and every assertion is about a port, a verdict, or a call —
  things that are either true or false, the same way, every run.
- **Not a live test.** An eval never leaves the machine (see
  [Nothing reaches a network](#nothing-reaches-a-network)). Runtime behaviour
  against a real venue belongs to a testnet run, not to CI.
- **Not blueprint validation.** `validateCrewBlueprint` already checks that a
  blueprint is coherent. Evals check what a _run_ of it does.

## Anatomy of a scenario

```ts
import type { FlowEvalScenario } from "@lacrew/flows";

const scenario: FlowEvalScenario = {
  id: "github-experts/merge-refused",
  describe:
    "A mergeable bot PR on a crew whose merge authority is not admitted: policy answers DENY, the run writes the refusal note, and the merge route is never called.",

  flow: "bot-pr-triage", // template id, definition id, or `definition:`
  blueprint: "github-experts", // binds {{crew.*}} / {{target.*}}
  asAgent: "reviewer", // the seat the run executes as
  input: { owner: "marc-aurele-besner", repo: "lacrew", number: 94 },

  mocks: {
    // The far side of every connector route the run touches.
    tools: {
      "github.get_pull_request": { result: { ok: true, body: {/* … */} } },
    },
    // Scripted model turns, matched on a substring of the rendered prompt.
    model: [{ when: "MERGE (safe, CI green", reply: "MERGE" }],
    // What policy answers, in blueprint vocabulary.
    policy: { targets: { "merge-authority": "DENY" } },
  },

  expect: {
    status: "completed",
    ran: [
      "pr",
      "classify",
      "route",
      "merge-check",
      "may-merge",
      "merge-blocked",
    ],
    notRan: ["merge"],
    port: { "may-merge": "merge-blocked" },
    called: { "github.get_pull_request": 1 },
    notCalled: ["github.merge_pull_request"],
  },
};
```

The suite that ships lives in
[`packages/flows/src/evalSuite.ts`](https://github.com/marc-aurele-besner/lacrew/blob/main/packages/flows/src/evalSuite.ts).
Add a scenario there and it runs in CI on the next PR.

## The assertions

Every assertion speaks the product's language, not the engine's.

| Assertion          | Asks                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `status`           | how the run ended — `completed`, `error`, `waiting`, `cancelled`   |
| `waiting`          | what it parked on: `{ reason, stepId }`                            |
| `ran`              | these steps happened, in this order (gaps allowed)                 |
| `notRan`           | this step never happened                                           |
| `port`             | step → the step it routed to; `null` asserts the run stopped there |
| `verdict`          | step → the verdict it read off policy                              |
| `called`           | tool name (or `model`) → exact call count                          |
| `notCalled`        | this route was never called                                        |
| `noConnectorCalls` | no `<connector>.<route>` at all — the "no HTTP" assertion          |
| `questionOpen`     | a human gate was opened and left for someone                       |
| `auditIncludes`    | this string appears somewhere on the trail                         |

`called` counts exactly. `{ "github.merge_pull_request": 1 }` is the assertion
that a retry edge has not turned one merge into two.

## The test doubles

**Connectors.** Every `<connector>.<route>` call is recorded, whether or not it
is mocked. An unmocked route returns the same "no connector registered" shape an
offline run produces — so a scenario that forgets a mock fails on the port it
takes, not on a fabricated success.

**Models.** `mocks.model` entries are matched against the _interpolated_ system

- prompt and consumed in declaration order, so a flow that asks the same
  question twice can be answered differently the second time. Add `always: true`
  to reuse an entry. An unscripted completion returns one constant string — never
  anything a branch could read two ways.

**Policy.** `mocks.policy.targets` names targets the way the blueprint does
(`merge-authority`, `dex-router`), or by raw address. Anything you do not name
falls back to the blueprint's own `whitelisted` flag, so a scenario states only
what it is actually pinning — and _admitting a venue in the blueprint turns
every eval that assumed the refusal red_, which is the regression this exists to
catch. A target nothing answers for reads `ESCALATE`: an unanswered policy
question must never look like approval.

**Human gates.** An unscripted `human` step parks the run and reports
`questionOpen`. There is no canned yes: a gate that passes offline would be the
one failure mode a blocking gate must never have. Script an answer with
`mocks.gates: { "sign-off": { outcome: "answered", optionId: "yes" } }`.

## A scenario cannot fake authority

```ts
policy: {
  targets: { "dex-router": "ALLOW" },
  admitsUnadmitted: ["dex-router"],   // required, or the scenario fails
}
```

Mocking `ALLOW` for a target the blueprint deliberately does not admit is
refused unless the scenario declares it. Otherwise the easiest way to make a
failing eval green would be to grant the crew authority it does not have —
which is precisely the drift the suite is meant to catch.

The one scenario that means it, `lp-advisor/router-admitted-is-drift`, asserts
that the flow treats an admitted router as _drift to report_, not as permission
to trade.

## Nothing reaches a network

`fetch` is blocked for the duration of every run. A run that tries to reach
`api.github.com` — through a connector client, an SDK, a model provider, any
layer below the flow — fails the scenario with the URL it tried. "No real HTTP
in CI logs" is a property of the runner, not a promise in a doc.

Determinism is enforced the same way: run ids are derived from the scenario id,
scenarios run sequentially, and nothing consults a clock. A failure reads
identically on your laptop and in CI.

## Running them in CI

The `Evals` job runs on every pull request:

```bash
pnpm --filter @lacrew/flows eval
```

It prints one line per scenario, the diff for each failure, and a **coverage
warning** naming first-party flows that no scenario runs. The warning does not
fail the build — a threshold nobody agreed to would go red the day someone adds
a template, and the first fix for that is to delete the check. Naming the gap is
what makes adding a scenario the obvious move.

The suite also runs under `pnpm test` (`packages/flows/src/evals.test.ts`),
alongside the mutation tests that keep the harness honest: break `bot-pr-triage`
so a `DENY` still merges, and the golden scenario has to go red naming
`github.merge_pull_request`. An eval suite that survives that mutation is
decoration.

## Running them from a workspace

CI answers "did anyone break this on the way in". An operator has a different
question — *my* desk, the blueprint I installed, right now — and reading a badge
on someone else's repository is not an answer to it. So the orchestrator serves
the same suite:

```bash
curl -s http://127.0.0.1:8788/flows/eval | jq '.scenarios[].id'
curl -s -X POST http://127.0.0.1:8788/flows/eval \
  -H 'content-type: application/json' \
  -d '{"blueprint":"github-experts"}' | jq '{ok, passed, failed, matched}'
```

`{"ids":[…]}`, `{"flow":"…"}` and `{"blueprint":"…"}` all filter; naming
nothing runs everything. A filter that matches no scenario reports
`matched: 0` rather than a green suite — a pass that tested nothing is the one
result worth refusing to render as success.

**The suite runs in a child process**, and that is not an implementation
detail. The harness blocks `fetch` for the duration of a run; inside a
long-lived orchestrator that block would fail every connector call, model
completion and RPC read in flight. A funded crew's work must not break because
somebody pressed "run evals". The child exists to be blocked, and this
process's `fetch` is untouched.

One run at a time. A second request while one is in flight is refused with
`409 eval_already_running` rather than queued: the caller wants the state of
things now, and a queue would hand them a stale answer later. A run that
outlives `LACREW_EVAL_TIMEOUT_MS` (default 120s) is killed and reported as
`504 eval_timeout`.

Each run leaves a `FlowEvalRun` audit row — counts and timing, never a
scenario's contents. An eval changes nothing, so the row is not evidence about
the crew; it is evidence about when the question was last asked, which is what
a reader wants when a desk starts behaving differently.

## When to add one

Add a scenario when you:

- add or edit a flow a blueprint ships;
- change a connector route a flow calls, or its write policy mode;
- change how a verdict routes — a new port, a changed default, a new `switch`
  case;
- fix a bug where a run did something the blueprint says it cannot. The eval is
  the regression test.

Copy the block under [Anatomy of a scenario](#anatomy-of-a-scenario), point it
at your flow, and run `lacrew flows eval <your-scenario-id>` until it says what
you mean.

## Related

- [Flows](./flows.md) — the pipelines being evaluated
- [Crew blueprints](./crews.md) — where the guarantees are written down
- [Connectors](./connectors.md) — the write policy an eval asserts against

/**
 * Delegated ask / gate, end to end (F2.24 + F2.27, on F2.26's checkpoints): an
 * `agent` step runs a child flow, the child stops on a connector ask or a
 * blocking human gate, and the *parent* parks instead of failing.
 *
 * Driven through the real flows surface, the real ask and gate surfaces and the
 * real connector registry with only the network stubbed. The criteria here are
 * behavioural — "no write before the answer, exactly one after, the parent
 * finishes once" — and a test that mocked the suspension would assert the shape
 * of the design rather than any of that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flow } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { createConnectorAsks } from "./connectorAsks.js";
import { createConnectorModes } from "./connectorPolicy.js";
import { createConnectorRegistry, type Connector } from "./connectors.js";
import { scopeOfThread } from "./conversation.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createHumanGates } from "./humanGates.js";
import { MemoryModelProvider } from "./model/index.js";
import { CrewRuntime } from "./runtime.js";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";

const WORKER = "0x1111111111111111111111111111111111111111";

const github: Connector = {
  id: "github",
  baseUrl: "https://api.github.com",
  auth: { kind: "bearer", tokenEnv: "GH_TOKEN" },
  routes: [
    {
      name: "merge_pull_request",
      method: "PUT",
      path: "/repos/{owner}/{repo}/pulls/{number}/merge",
      effect: "write",
      params: ["merge_method"],
      mode: "ask",
    },
  ],
};

function harness() {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ merged: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const modes = createConnectorModes({});
  const post = ({
    threadId,
    author,
    body,
    options,
  }: {
    threadId: string;
    author: string;
    body: string;
    options: string[];
  }) =>
    runtime.postMessage({
      scope: scopeOfThread(threadId) ?? { kind: "org" },
      author,
      authorKind: "agent",
      kind: "question",
      body,
      options,
    });

  const asks = createConnectorAsks({
    postQuestion: post,
    onEvent: (event) => runtime.recordAudit(event),
  });
  const gates = createHumanGates({
    postQuestion: post,
    onEvent: (event) => runtime.recordAudit(event),
  });
  runtime.onMessage((message) => {
    asks.observe(message);
    gates.observe(message);
  });

  const connectors = createConnectorRegistry({
    connectors: [github],
    env: { GH_TOKEN: "ghp_secret" },
    fetchImpl,
    checkPolicy: async () => "ALLOW",
    resolveMode: (route, id, subject) => modes.resolve(route, id, subject),
    asks,
  });

  const store = createMemoryFlowStore();
  const surface = createFlowsSurface({
    runtime,
    model: new MemoryModelProvider(),
    // Any backend flips the surface off its detached mock and onto the live
    // dispatch path, which is where connectors, asks and gates are reached.
    mcpBackend: {} as McpToolBackend,
    store,
    connectors,
    asks,
    gates,
  });

  return { runtime, surface, store, asks, gates, modes, calls };
}

/** Parent delegates to a child whose only write is an ask-mode merge. */
async function installAskChain(h: ReturnType<typeof harness>) {
  await h.surface.save(
    flow("merge-pr", "Merge a PR")
      .tool("merge", "github.merge_pull_request", {
        owner: "acme",
        repo: "site",
        number: "7",
        merge_method: "squash",
      })
      .build(),
  );
  await h.surface.save(
    flow("desk", "Desk")
      .agent("hand-off", { action: "invoke", agent: WORKER, flowId: "merge-pr", next: "wrap" })
      .model("wrap", { prompt: "Summarise what the specialist did.", next: null })
      .build(),
  );
}

function pendingAsk(h: ReturnType<typeof harness>) {
  const ask = h.asks.list().find((a) => a.status === "pending");
  assert.ok(ask, "expected a pending ask");
  return ask;
}

function answer(h: ReturnType<typeof harness>, questionId: string, threadId: string, body: string) {
  h.runtime.postMessage({
    scope: scopeOfThread(threadId)!,
    author: "human:ops",
    authorKind: "human",
    kind: "answer",
    body,
    replyTo: questionId,
  });
}

describe("delegated ask / gate parks the delegating run", () => {
  it("parks the parent on the child's ask, and finishes both on one answer", async () => {
    const h = harness();
    await installAskChain(h);

    const parked = await h.surface.run({ id: "desk" });
    assert.equal(parked.status, "waiting");
    assert.equal(parked.waiting?.reason, "awaiting_child");
    assert.equal(parked.waiting?.stepId, "hand-off");
    assert.equal(h.calls.length, 0, "nothing was merged before anyone answered");

    const ask = pendingAsk(h);
    // The token names the run holding the parent up, and the child's own state
    // names the run it is holding — the link is durable in both directions.
    assert.equal(parked.waiting?.token, ask.runId);
    const child = await h.surface.runState(ask.runId!);
    assert.equal(child?.status, "waiting");
    assert.equal(child?.parentRunId, parked.runId);
    assert.equal(child?.parentStepId, "hand-off");

    // One question, asked where the write is — not two, one per level.
    assert.equal(h.runtime.allOpenQuestions().length, 1);

    answer(h, ask.questionId, ask.threadId, "yes");
    await h.asks.drain();

    assert.equal(h.calls.length, 1, "exactly one merge went out");
    const parent = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(parent?.status, "completed");
    // The trail keeps the pause and the release as two entries for one step —
    // that is what a resumed run looks like — but only one of them acted.
    const handOff = parent?.steps.filter((s) => s.stepId === "hand-off") ?? [];
    assert.deepEqual(
      handOff.map((s) => s.status),
      ["waiting", "ok"],
      "the delegating step parked once and resolved once",
    );
    assert.equal(
      h.surface.runs().filter((r) => r.runId === parked.runId).length,
      1,
      "the resumed parent replaces its waiting entry rather than appearing twice",
    );
    assert.equal(
      (await h.store.childRuns(parked.runId)).length,
      1,
      "the resumed parent re-entered its delegate rather than starting a second one",
    );
    assert.equal(h.runtime.allOpenQuestions().length, 0, "the question closed");
  });

  it("a no fails the delegating step, and never calls", async () => {
    const h = harness();
    await installAskChain(h);
    const parked = await h.surface.run({ id: "desk" });
    const ask = pendingAsk(h);

    answer(h, ask.questionId, ask.threadId, "no");
    await h.asks.drain();

    assert.equal(h.calls.length, 0);
    const parent = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(parent?.status, "error");
    assert.match(String(parent?.steps.at(-1)?.error), /flow_delegate_failed/);
  });

  it("survives a restart mid-pause: hydration leaves both parked, one answer resumes both", async () => {
    const h = harness();
    await installAskChain(h);
    const parked = await h.surface.run({ id: "desk" });
    const ask = pendingAsk(h);

    // What a boot does with runs it finds in the durable state. A parked run is
    // waiting on something, not stalled, so neither level may be picked up here
    // — and picking the parent up would re-run the delegate.
    const hydrated = await h.surface.hydrateRuns();
    assert.equal(hydrated.paused, 2, "the parent and its delegate are both parked");
    assert.equal(hydrated.resumed, 0);
    assert.equal(hydrated.failed, 0);
    assert.equal(h.calls.length, 0);

    answer(h, ask.questionId, ask.threadId, "yes");
    await h.asks.drain();

    assert.equal(h.calls.length, 1, "exactly one merge, across the restart");
    assert.equal(h.surface.runs().find((r) => r.runId === parked.runId)?.status, "completed");
  });

  it("cancelling the parent ends the delegate and closes its question", async () => {
    const h = harness();
    await installAskChain(h);
    const parked = await h.surface.run({ id: "desk" });
    const ask = pendingAsk(h);

    await h.surface.cancel(parked.runId, "operator changed their mind");

    assert.equal((await h.surface.runState(parked.runId))?.status, "cancelled");
    assert.equal(
      (await h.surface.runState(ask.runId!))?.status,
      "cancelled",
      "a delegate left runnable behind a cancelled parent is the orphan this refuses",
    );
    assert.equal(h.asks.list()[0]!.status, "cancelled");

    // A late yes lands on a closed question and starts nothing.
    answer(h, ask.questionId, ask.threadId, "yes");
    await h.asks.drain();
    assert.equal(h.calls.length, 0);
    assert.equal(h.surface.runs().find((r) => r.runId === parked.runId)?.status, "cancelled");
  });

  it("parks every level of a nested chain, and releases them in order", async () => {
    const h = harness();
    await installAskChain(h);
    await h.surface.save(
      flow("desk-of-desks", "Desk of desks")
        .agent("delegate", { action: "invoke", agent: WORKER, flowId: "desk", next: "wrap" })
        .model("wrap", { prompt: "Summarise the desk's work.", next: null })
        .build(),
    );

    const parked = await h.surface.run({ id: "desk-of-desks" });
    assert.equal(parked.waiting?.reason, "awaiting_child");

    const open = await h.surface.openRuns();
    assert.equal(open.length, 3, "grandparent, parent and the run holding the write");
    assert.ok(open.every((r) => r.status === "waiting"));
    assert.equal(h.runtime.allOpenQuestions().length, 1, "still one question, at the write");

    const ask = pendingAsk(h);
    answer(h, ask.questionId, ask.threadId, "yes");
    await h.asks.drain();

    assert.equal(h.calls.length, 1);
    assert.equal(
      h.surface.runs().find((r) => r.runId === parked.runId)?.status,
      "completed",
      "the answer travelled all the way back up",
    );
    assert.equal((await h.surface.openRuns()).length, 0, "nothing is left parked");
  });

  it("parks the parent on a blocking human gate, and follows the branch the answer takes", async () => {
    const h = harness();
    // The child's gate decides whether the write happens at all; "no" routes to
    // a step that writes nothing, which is what a reject port is for.
    await h.surface.save(
      flow("merge-with-signoff", "Merge with sign-off")
        .human("signoff", {
          prompt: "Merge this pull request?",
          options: [
            { id: "yes", label: "Merge", port: "merge" },
            { id: "no", label: "Skip", port: "skipped" },
          ],
          timeoutPort: "skipped",
        })
        .tool(
          "merge",
          "github.merge_pull_request",
          { owner: "acme", repo: "site", number: "7", merge_method: "squash" },
          { next: null },
        )
        .model("skipped", { prompt: "Nothing was merged.", next: null })
        .build(),
    );
    await h.surface.save(
      flow("desk-gate", "Desk")
        .agent("hand-off", {
          action: "invoke",
          agent: WORKER,
          flowId: "merge-with-signoff",
          next: "wrap",
        })
        .model("wrap", { prompt: "Report what the specialist decided.", next: null })
        .build(),
    );
    // The ask-mode rule would ask a second question on the merge itself; the
    // gate is the control under test, so the route is admitted directly.
    await h.modes.set({ scope: { level: "workspace" }, route: "github.*", mode: "auto" });

    const parked = await h.surface.run({ id: "desk-gate" });
    assert.equal(parked.waiting?.reason, "awaiting_child");
    assert.equal(h.calls.length, 0);

    const gate = h.gates.list().find((g) => g.status === "pending");
    assert.ok(gate, "expected an open gate");
    answer(h, gate.questionId, gate.threadId, "no");
    await h.gates.drain();

    assert.equal(h.calls.length, 0, "the reject port skips the write");
    const parent = h.surface.runs().find((r) => r.runId === parked.runId);
    assert.equal(parent?.status, "completed", "the parent follows the delegate's own outcome");
    assert.equal(parent?.steps.at(-1)?.stepId, "wrap");
  });
});

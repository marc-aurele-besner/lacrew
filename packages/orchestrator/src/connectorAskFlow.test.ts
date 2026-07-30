/**
 * The ask lane end to end (F2.24): a flow reaches an `ask`-mode connector
 * write, stops, a human answers in the thread, and the run finishes.
 *
 * Driven through the real flows surface and the real connector registry, with
 * only the network stubbed — the acceptance criterion is behavioural ("no call
 * before the answer"), and a test that mocked the gate would assert the design
 * rather than the behaviour.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flow } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { connectorAskTtlMs, createConnectorAsks } from "./connectorAsks.js";
import { createConnectorModes } from "./connectorPolicy.js";
import { createConnectorRegistry, type Connector } from "./connectors.js";
import { scopeOfThread } from "./conversation.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { MemoryModelProvider } from "./model/index.js";
import { CrewRuntime } from "./runtime.js";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";

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

function harness(opts: { ttlMs?: number; now?: () => Date } = {}) {
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
  const asks = createConnectorAsks({
    postQuestion: ({ threadId, author, body, options }) =>
      runtime.postMessage({
        scope: scopeOfThread(threadId) ?? { kind: "org" },
        author,
        authorKind: "agent",
        kind: "question",
        body,
        options,
      }),
    onEvent: (event) => runtime.recordAudit(event),
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  runtime.onMessage((message) => asks.observe(message));

  const connectors = createConnectorRegistry({
    connectors: [github],
    env: { GH_TOKEN: "ghp_secret" },
    fetchImpl,
    checkPolicy: async () => "ALLOW",
    resolveMode: (route, id, subject) => modes.resolve(route, id, subject),
    asks,
  });

  const surface = createFlowsSurface({
    runtime,
    model: new MemoryModelProvider(),
    // Any backend flips the surface off its detached mock and onto the live
    // dispatch path, which is where connector tools are reached.
    mcpBackend: {} as McpToolBackend,
    store: createMemoryFlowStore(),
    connectors,
    asks,
  });

  const def = flow("pr-merge", "Merge a PR")
    .tool("merge", "github.merge_pull_request", {
      owner: "acme",
      repo: "site",
      number: "7",
      merge_method: "squash",
    })
    .build();

  return { runtime, surface, asks, modes, calls, def };
}

/** The question the run is waiting on, in the thread it was posted to. */
function openAsk(h: ReturnType<typeof harness>) {
  const ask = h.asks.list().find((a) => a.status === "pending");
  assert.ok(ask, "expected a pending ask");
  return ask;
}

describe("connector ask mode, end to end", () => {
  it("stops the run before the call, and finishes it once a human says yes", async () => {
    const h = harness();
    await h.surface.save(h.def);

    const suspended = await h.surface.run({ id: "pr-merge" });
    assert.equal(suspended.status, "waiting");
    assert.equal(suspended.waiting?.reason, "connector_ask");
    assert.equal(h.calls.length, 0, "nothing was merged before anyone answered");

    const ask = openAsk(h);
    assert.equal(ask.runId, suspended.runId);
    assert.ok(ask.resume, "the suspended run is attached to the ask holding it up");

    // The question is in the human's queue.
    const queue = h.runtime.allOpenQuestions();
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.id, ask.questionId);

    h.runtime.postMessage({
      scope: scopeOfThread(ask.threadId)!,
      author: "human:ops",
      authorKind: "human",
      kind: "answer",
      body: "yes",
      replyTo: ask.questionId,
    });
    await h.asks.drain();

    assert.equal(h.calls.length, 1, "exactly one merge went out");
    assert.match(h.calls[0]!, /\/repos\/acme\/site\/pulls\/7\/merge$/);

    const finished = h.surface.runs().find((r) => r.runId === suspended.runId);
    assert.equal(finished?.status, "completed");
    assert.equal(
      h.surface.runs().filter((r) => r.runId === suspended.runId).length,
      1,
      "the resumed run replaces its own waiting entry rather than appearing twice",
    );
    assert.equal(h.runtime.allOpenQuestions().length, 0, "the question closed");
  });

  it("skips the write when the human says no, without calling", async () => {
    const h = harness();
    await h.surface.save(h.def);
    const suspended = await h.surface.run({ id: "pr-merge" });
    const ask = openAsk(h);

    h.runtime.postMessage({
      scope: scopeOfThread(ask.threadId)!,
      author: "human:ops",
      authorKind: "human",
      kind: "answer",
      body: "no",
      replyTo: ask.questionId,
    });
    await h.asks.drain();

    assert.equal(h.calls.length, 0);
    const finished = h.surface.runs().find((r) => r.runId === suspended.runId);
    assert.equal(finished?.status, "error");
    assert.match(String(finished?.steps.at(-1)?.error), /connector_ask_declined/);
  });

  it('reads "approve 500 USDC" as a claim, not as a confirmation', async () => {
    const h = harness();
    await h.surface.save(h.def);
    await h.surface.run({ id: "pr-merge" });
    const ask = openAsk(h);

    h.runtime.postMessage({
      scope: scopeOfThread(ask.threadId)!,
      author: "human:ops",
      authorKind: "human",
      kind: "answer",
      body: "approve 500 USDC",
      replyTo: ask.questionId,
    });
    await h.asks.drain();

    assert.equal(h.calls.length, 0, "free text never fires the write");
    assert.equal(h.asks.list()[0]!.status, "pending");
    assert.equal(
      h.runtime.allOpenQuestions().length,
      1,
      "the write is still waiting, so the queue still shows it",
    );
  });

  it("times out without calling, and the resumed step says why", async () => {
    let clock = new Date("2026-01-01T12:00:00.000Z");
    const h = harness({ ttlMs: 60_000, now: () => clock });
    await h.surface.save(h.def);
    const suspended = await h.surface.run({ id: "pr-merge" });

    clock = new Date("2026-01-01T12:05:00.000Z");
    await h.asks.sweep();
    await h.asks.drain();

    assert.equal(h.calls.length, 0);
    const finished = h.surface.runs().find((r) => r.runId === suspended.runId);
    assert.equal(finished?.status, "error");
    assert.match(String(finished?.steps.at(-1)?.error), /connector_ask_timeout/);
  });

  it("a deny rule refuses the route without reaching the network or a human", async () => {
    const h = harness();
    await h.modes.set({
      scope: { level: "workspace" },
      route: "github.merge_pull_request",
      mode: "deny",
    });
    await h.surface.save(h.def);

    const run = await h.surface.run({ id: "pr-merge" });
    assert.equal(run.status, "error");
    assert.match(String(run.steps.at(-1)?.error), /connector_mode_denied/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.asks.list().length, 0, "deny asks nobody anything");
  });

  it("an auto rule lets an admitted write straight through", async () => {
    const h = harness();
    await h.modes.set({
      scope: { level: "workspace" },
      route: "github.*",
      mode: "auto",
    });
    await h.surface.save(h.def);

    const run = await h.surface.run({ id: "pr-merge" });
    assert.equal(run.status, "completed");
    assert.equal(h.calls.length, 1);
    assert.equal(h.asks.list().length, 0);
  });

  it("the ask TTL is read from the environment, with a floor", () => {
    assert.equal(connectorAskTtlMs({}), 24 * 60 * 60 * 1000);
    assert.equal(connectorAskTtlMs({ LACREW_CONNECTOR_ASK_TTL_MS: "3600000" }), 3_600_000);
    assert.equal(
      connectorAskTtlMs({ LACREW_CONNECTOR_ASK_TTL_MS: "5" }),
      24 * 60 * 60 * 1000,
      "a deadline that fires on people rather than on neglect is refused",
    );
  });
});

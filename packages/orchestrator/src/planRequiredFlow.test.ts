/**
 * Plan-required mode end to end (F2.31): a flow reaches a side effect, and
 * whether it goes out depends on what the acting agent said in its thread first.
 *
 * Driven through the real flows surface, the real connector registry and the
 * real conversation, with only the network stubbed. The acceptance criterion is
 * behavioural — "zero HTTP when it is refused" — and the connector's own call
 * log is what proves it, not the absence of an exception.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flow } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { createConnectorAsks } from "./connectorAsks.js";
import { createConnectorRegistry, type Connector } from "./connectors.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { MemoryModelProvider } from "./model/index.js";
import { createPlanRequirements } from "./planRequired.js";
import { CrewRuntime } from "./runtime.js";
import { scopeOfThread } from "./conversation.js";
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
    },
    {
      name: "get_pull_request",
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls/{number}",
      effect: "read",
    },
  ],
};

const PLAN = "Merging acme/site#7 after review: squash, then report the sha in-thread.";

function harness(opts: { now?: () => Date } = {}) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ merged: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const planRequired = createPlanRequirements({
    messagesIn: (threadId) => runtime.thread(scopeOfThread(threadId) ?? { kind: "org" }, 200),
    onEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
    ...(opts.now ? { now: opts.now } : {}),
  });

  const connectors = createConnectorRegistry({
    connectors: [github],
    env: { GH_TOKEN: "ghp_secret" },
    fetchImpl,
    checkPolicy: async () => "ALLOW",
  });

  const surface = createFlowsSurface({
    runtime,
    model: new MemoryModelProvider(),
    // Any backend flips the surface off its detached mock and onto the live
    // dispatch path, which is where connector tools are reached.
    mcpBackend: {} as McpToolBackend,
    store: createMemoryFlowStore(),
    connectors,
    planRequired,
  });

  const merge = flow("pr-merge", "Merge a PR")
    .tool("merge", "github.merge_pull_request", {
      owner: "acme",
      repo: "site",
      number: "7",
      merge_method: "squash",
    })
    .build();

  const read = flow("pr-read", "Read a PR")
    .tool("read", "github.get_pull_request", { owner: "acme", repo: "site", number: "7" })
    .build();

  const spend = flow("desk-spend", "Spend from the desk")
    .gate("pay", { value: "1000000" })
    .build();

  return { runtime, surface, planRequired, calls, events, merge, read, spend };
}

/** Post a plan as the seat the run executes as. */
function postPlan(h: ReturnType<typeof harness>, body = PLAN): void {
  h.runtime.postMessage({
    scope: { kind: "agent", account: h.runtime.defaultAgent },
    author: h.runtime.defaultAgent,
    authorKind: "agent",
    kind: "plan",
    body,
  });
}

describe("plan-required mode, end to end", () => {
  it("refuses a connector write with no plan, and reaches no network", async () => {
    const h = harness();
    await h.planRequired.set({ scope: { level: "workspace" }, mode: "side_effects" });
    await h.surface.save(h.merge);

    const blocked = await h.surface.run({ id: "pr-merge" });
    assert.equal(blocked.status, "error");
    assert.match(blocked.steps[0]?.error ?? "", /^plan_required:github\.merge_pull_request:none/);
    assert.equal(h.calls.length, 0, "nothing was merged with no plan on the record");

    const audit = h.events.find((e) => e.type === "PlanRequiredBlocked");
    assert.ok(audit, "the attempt left a row — it leaves no other trace");
    assert.equal(audit.payload.tool, "github.merge_pull_request");
    assert.equal(audit.payload.effect, "write");
    assert.equal(audit.payload.miss, "none");
    // The refusal names the run it stopped, and never the thread's contents.
    assert.equal(audit.payload.runId, blocked.runId);
    assert.ok(!JSON.stringify(audit.payload).includes(PLAN));
  });

  it("lets the same run through once the agent has said what it is doing", async () => {
    const h = harness();
    await h.planRequired.set({ scope: { level: "workspace" }, mode: "side_effects" });
    await h.surface.save(h.merge);
    postPlan(h);

    const ran = await h.surface.run({ id: "pr-merge" });
    assert.equal(ran.status, "completed");
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0] ?? "", /pulls\/7\/merge$/);
  });

  it("never gates a read", async () => {
    const h = harness();
    await h.planRequired.set({ scope: { level: "workspace" }, mode: "side_effects" });
    await h.surface.save(h.read);

    const ran = await h.surface.run({ id: "pr-read" });
    assert.equal(ran.status, "completed");
    assert.equal(h.calls.length, 1);
  });

  it("spends_only blocks the propose and leaves the connector write alone", async () => {
    const h = harness();
    await h.planRequired.set({ scope: { level: "workspace" }, mode: "spends_only" });
    await h.surface.save(h.merge);
    await h.surface.save(h.spend);

    const merged = await h.surface.run({ id: "pr-merge" });
    assert.equal(merged.status, "completed", "a write is not a spend");
    assert.equal(h.calls.length, 1);

    const spent = await h.surface.run({ id: "desk-spend" });
    assert.equal(spent.status, "error");
    assert.match(spent.steps[0]?.error ?? "", /^plan_required:lacrew_propose_intent:none/);
  });

  it("a plan outside the window does not cover a later run", async () => {
    // The conversation stamps a message with the wall clock, so the clock that
    // moves is the checker's: the plan is posted now, and a run started an hour
    // later asks about it. Read against the live thread the flows surface uses.
    let clock = new Date();
    const h = harness({ now: () => clock });
    await h.planRequired.set({
      scope: { level: "workspace" },
      mode: "side_effects",
      windowMs: 10 * 60_000,
    });
    postPlan(h);

    clock = new Date(clock.getTime() + 3_600_000);
    await assert.rejects(
      () =>
        h.planRequired.check({
          tool: "github.merge_pull_request",
          principal: h.runtime.defaultAgent,
          runStartedAt: clock.toISOString(),
        }),
      // Nothing about the plan is less true; it is simply no longer the crew's
      // current statement of intent.
      (err: unknown) => String((err as Error).message).includes("merge_pull_request:stale"),
    );
    assert.equal(h.calls.length, 0);
  });

  it("mode off is the behaviour crews had before the mode existed", async () => {
    const h = harness();
    await h.planRequired.set({ scope: { level: "workspace" }, mode: "off" });
    await h.surface.save(h.merge);

    const ran = await h.surface.run({ id: "pr-merge" });
    assert.equal(ran.status, "completed");
    assert.equal(h.calls.length, 1);
  });

  it("a run that waited on a human keeps the plan it started with", async () => {
    // The interaction that would otherwise make plan-required and ask-mode
    // mutually exclusive: the run plans, parks on the confirmation, a person
    // answers an hour later, and the resumed step must not refuse the write it
    // was just told to make.
    let clock = new Date();
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ merged: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

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
    });
    runtime.onMessage((m) => asks.observe(m));
    const planRequired = createPlanRequirements({
      messagesIn: (threadId) => runtime.thread(scopeOfThread(threadId) ?? { kind: "org" }, 200),
      now: () => clock,
    });
    await planRequired.set({
      scope: { level: "workspace" },
      mode: "side_effects",
      windowMs: 10 * 60_000,
    });

    const surface = createFlowsSurface({
      runtime,
      model: new MemoryModelProvider(),
      mcpBackend: {} as McpToolBackend,
      store: createMemoryFlowStore(),
      connectors: createConnectorRegistry({
        connectors: [{ ...github, routes: [{ ...github.routes[0]!, mode: "ask" }] }],
        env: { GH_TOKEN: "ghp_secret" },
        fetchImpl,
        checkPolicy: async () => "ALLOW",
        asks,
      }),
      asks,
      planRequired,
    });
    await surface.save(
      flow("pr-merge", "Merge a PR")
        .tool("merge", "github.merge_pull_request", {
          owner: "acme",
          repo: "site",
          number: "7",
          merge_method: "squash",
        })
        .build(),
    );

    runtime.postMessage({
      scope: { kind: "agent", account: runtime.defaultAgent },
      author: runtime.defaultAgent,
      authorKind: "agent",
      kind: "plan",
      body: PLAN,
    });
    const parked = await surface.run({ id: "pr-merge" });
    assert.equal(parked.status, "waiting", "the write is waiting on a human");
    assert.equal(calls.length, 0);

    // The person takes an hour. The plan is now well outside the window.
    clock = new Date(clock.getTime() + 3_600_000);
    const ask = asks.list().find((a) => a.status === "pending");
    assert.ok(ask);
    runtime.postMessage({
      scope: { kind: "agent", account: runtime.defaultAgent },
      author: "alice",
      authorKind: "human",
      kind: "answer",
      replyTo: ask.questionId,
      body: "yes",
    });
    await asks.drain();

    assert.equal(calls.length, 1, "the answered write went out rather than being re-refused");
  });

  it("keeps the crew working when the checker itself cannot answer", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const planRequired = createPlanRequirements({
      messagesIn: () => {
        throw new Error("thread unreadable");
      },
    });
    await planRequired.set({ scope: { level: "workspace" }, mode: "side_effects" });

    const surface = createFlowsSurface({
      runtime,
      model: new MemoryModelProvider(),
      mcpBackend: {} as McpToolBackend,
      store: createMemoryFlowStore(),
      connectors: createConnectorRegistry({
        connectors: [github],
        env: { GH_TOKEN: "ghp_secret" },
        fetchImpl,
        checkPolicy: async () => "ALLOW",
      }),
      planRequired,
    });
    await surface.save(
      flow("pr-merge", "Merge a PR")
        .tool("merge", "github.merge_pull_request", {
          owner: "acme",
          repo: "site",
          number: "7",
          merge_method: "squash",
        })
        .build(),
    );

    // Deliberate, and the opposite of how budgets and the MCP allowlist fail:
    // this control guards legibility, and every onchain and connector bound is
    // still in front of the call.
    const ran = await surface.run({ id: "pr-merge" });
    assert.equal(ran.status, "completed");
    assert.equal(calls.length, 1);
  });

  it("an agent-scope rule carves one seat out of a workspace requirement", async () => {
    const h = harness();
    await h.planRequired.set({ scope: { level: "workspace" }, mode: "side_effects" });
    await h.planRequired.set({ scope: { level: "agent", ref: h.runtime.defaultAgent }, mode: "off" });
    await h.surface.save(h.merge);

    const ran = await h.surface.run({ id: "pr-merge" });
    assert.equal(ran.status, "completed");
    assert.equal(h.calls.length, 1);
  });
});

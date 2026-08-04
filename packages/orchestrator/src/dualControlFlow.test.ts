/**
 * Dual control end to end (F2.32): a flow reaches a risky effect, and whether
 * it happens depends on a *different* seat answering in the thread.
 *
 * Driven through the real flows surface, the real connector registry and the
 * real conversation, with only the network stubbed. The acceptance criterion is
 * behavioural — "zero HTTP until somebody else concurs" — and the connector's
 * own call log is what proves it, not the absence of an exception.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flow } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { createConnectorRegistry, type Connector } from "./connectors.js";
import { createDualControl } from "./dualControl.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { MemoryModelProvider } from "./model/index.js";
import { CrewRuntime } from "./runtime.js";
import { scopeOfThread, type Message } from "./conversation.js";
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

const HUMAN = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x2222222222222222222222222222222222222222";

function harness(opts: { now?: () => Date } = {}) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const worker = runtime.defaultAgent.toLowerCase();
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ merged: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const dualControl = createDualControl({
    postQuestion: ({ threadId, author, body, options, to }) =>
      runtime.postMessage({
        scope: scopeOfThread(threadId) ?? { kind: "org" },
        author,
        authorKind: "agent",
        kind: "question",
        body,
        options,
        ...(to ? { to } : {}),
      }),
    // A three-level chart: a person at the root, a manager agent, and the seat
    // the runs execute as.
    orgSeats: () => [
      { account: HUMAN, kind: "human_root" as const, parent: null, active: true },
      { account: MANAGER, kind: "manager_agent" as const, parent: HUMAN, active: true },
      { account: worker, kind: "worker_agent" as const, parent: MANAGER, active: true },
    ],
    onEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  runtime.onMessage((message) => dualControl.observe(message));

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
    dualControl,
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

  const smallSpend = flow("desk-small", "Small clip").gate("pay", { value: "500000" }).build();

  const bigSpend = flow("desk-big", "Big clip").gate("pay", { value: "5000000" }).build();

  return {
    runtime,
    surface,
    dualControl,
    calls,
    events,
    worker,
    merge,
    read,
    smallSpend,
    bigSpend,
  };
}

type Harness = ReturnType<typeof harness>;

/** The question the parked run is waiting on. */
function openQuestion(h: Harness): Message {
  const pending = h.dualControl.reviews().filter((r) => r.status === "pending");
  assert.equal(pending.length, 1, "exactly one review is open");
  const review = pending[0]!;
  const thread = h.runtime.thread(scopeOfThread(review.threadId) ?? { kind: "org" }, 50);
  const question = thread.find((m) => m.id === review.questionId);
  assert.ok(question, "the review posted a question a reviewer can answer");
  return question!;
}

function answer(
  h: Harness,
  input: { author: string; authorKind: "agent" | "human"; body: string },
): void {
  const question = openQuestion(h);
  h.runtime.postMessage({
    scope: scopeOfThread(question.threadId) ?? { kind: "org" },
    author: input.author,
    authorKind: input.authorKind,
    kind: "answer",
    replyTo: question.id,
    body: input.body,
  });
}

describe("dual control, end to end", () => {
  it("parks the merge on a review and reaches no network until a second seat concurs", async () => {
    const h = harness();
    await h.dualControl.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    await h.surface.save(h.merge);

    const parked = await h.surface.run({ id: "pr-merge" });
    assert.equal(parked.status, "waiting");
    assert.equal(parked.waiting?.reason, "dual_control");
    assert.equal(h.calls.length, 0, "nothing was merged while the review was open");

    const opened = h.events.find((e) => e.type === "DualControlOpened");
    assert.ok(opened, "the parked effect left a row");
    assert.equal(opened.payload.tool, "github.merge_pull_request");
    assert.deepEqual(opened.payload.reviewers, [MANAGER]);
    assert.equal(opened.payload.escalated, false);
    // The trail carries the call's fingerprint, never its fields.
    assert.ok(!JSON.stringify(opened.payload).includes("acme"));

    answer(h, { author: MANAGER, authorKind: "agent", body: "concur" });
    await h.dualControl.drain();

    assert.equal(h.calls.length, 1, "the merge went out exactly once, after the concurrence");
    assert.match(h.calls[0] ?? "", /pulls\/7\/merge$/);
    assert.ok(h.events.some((e) => e.type === "DualControlConcurred"));
  });

  it("refuses the actor's own concurrence, and the merge stays unmade", async () => {
    const h = harness();
    await h.dualControl.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    await h.surface.save(h.merge);
    await h.surface.run({ id: "pr-merge" });

    answer(h, { author: h.worker, authorKind: "agent", body: "concur" });
    await h.dualControl.drain();

    assert.equal(h.calls.length, 0, "a crew cannot approve its own merge");
    const review = h.dualControl.reviews()[0]!;
    assert.equal(review.status, "pending", "the review is still open");
    const refused = h.events.find((e) => e.type === "DualControlUnresolved");
    assert.ok(refused, "the attempt is recorded rather than swallowed");
    assert.equal(refused.payload.reason, "self_concurrence");
  });

  it("a rejection ends the step and calls nothing", async () => {
    const h = harness();
    await h.dualControl.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    await h.surface.save(h.merge);
    await h.surface.run({ id: "pr-merge" });

    answer(h, { author: MANAGER, authorKind: "agent", body: "reject" });
    await h.dualControl.drain();

    assert.equal(h.calls.length, 0);
    const runs = h.surface.runs();
    const last = runs.at(-1)!;
    assert.equal(last.status, "error");
    assert.match(
      last.steps.at(-1)?.error ?? "",
      /^dual_control_rejected:github\.merge_pull_request/,
    );
    assert.ok(h.events.some((e) => e.type === "DualControlRejected"));
  });

  it("fails closed when nobody answers", async () => {
    let clock = new Date();
    const h = harness({ now: () => clock });
    await h.dualControl.set({
      scope: { level: "workspace" },
      mode: "risky_writes",
      timeoutMs: 10 * 60_000,
    });
    await h.surface.save(h.merge);
    await h.surface.run({ id: "pr-merge" });
    assert.equal(h.calls.length, 0);

    clock = new Date(clock.getTime() + 3_600_000);
    const timedOut = await h.dualControl.sweep();
    assert.equal(timedOut.length, 1);
    await h.dualControl.drain();

    assert.equal(h.calls.length, 0, "silence is not agreement");
    const last = h.surface.runs().at(-1)!;
    assert.equal(last.status, "error");
    assert.match(last.steps.at(-1)?.error ?? "", /^dual_control_timed_out/);
    assert.ok(h.events.some((e) => e.type === "DualControlTimedOut"));
  });

  it("never reviews a read", async () => {
    const h = harness();
    await h.dualControl.set({ scope: { level: "workspace" }, mode: "spends_and_writes" });
    await h.surface.save(h.read);

    const ran = await h.surface.run({ id: "pr-read" });
    assert.equal(ran.status, "completed");
    assert.equal(h.calls.length, 1);
    assert.equal(h.dualControl.reviews().length, 0);
  });

  it("lets a spend under the threshold through and stops the one above it", async () => {
    const h = harness();
    await h.dualControl.set({
      scope: { level: "workspace" },
      mode: "spends_and_writes",
      threshold: { minSpend: "1000000" },
    });
    await h.surface.save(h.smallSpend);
    await h.surface.save(h.bigSpend);

    const small = await h.surface.run({ id: "desk-small" });
    assert.notEqual(small.status, "waiting", "a clip under the threshold is not reviewed");
    assert.equal(h.dualControl.reviews().length, 0);

    const big = await h.surface.run({ id: "desk-big" });
    assert.equal(big.status, "waiting");
    assert.equal(big.waiting?.reason, "dual_control");
    const review = h.dualControl.reviews()[0]!;
    assert.equal(review.effect, "spend");
    assert.equal(review.value, "5000000");
  });

  it("risky_writes leaves the money path alone", async () => {
    const h = harness();
    await h.dualControl.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    await h.surface.save(h.bigSpend);

    const ran = await h.surface.run({ id: "desk-big" });
    assert.notEqual(ran.status, "waiting");
    assert.equal(h.dualControl.reviews().length, 0);
  });

  it("mode off is the behaviour crews had before the control existed", async () => {
    const h = harness();
    await h.dualControl.set({ scope: { level: "workspace" }, mode: "off" });
    await h.surface.save(h.merge);

    const ran = await h.surface.run({ id: "pr-merge" });
    assert.equal(ran.status, "completed");
    assert.equal(h.calls.length, 1);
  });

  it("a concurrence releases the call it was given for, and no other", async () => {
    const h = harness();
    await h.dualControl.set({ scope: { level: "workspace" }, mode: "risky_writes" });
    await h.surface.save(h.merge);
    await h.surface.run({ id: "pr-merge" });
    answer(h, { author: MANAGER, authorKind: "agent", body: "concur" });
    await h.dualControl.drain();
    assert.equal(h.calls.length, 1);

    // A different PR is a different call, so it asks again rather than riding
    // the concurrence the reviewer gave for the first one.
    const other = flow("pr-merge-2", "Merge another PR")
      .tool("merge", "github.merge_pull_request", {
        owner: "acme",
        repo: "site",
        number: "9",
        merge_method: "squash",
      })
      .build();
    await h.surface.save(other);
    const parked = await h.surface.run({ id: "pr-merge-2" });
    assert.equal(parked.status, "waiting");
    assert.equal(h.calls.length, 1, "the second merge is still unmade");
  });

  it("asks a person when the reviewer agent is paused, and lets them answer", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const worker = runtime.defaultAgent.toLowerCase();
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const dualControl = createDualControl({
      postQuestion: ({ threadId, author, body, options }) =>
        runtime.postMessage({
          scope: scopeOfThread(threadId) ?? { kind: "org" },
          author,
          authorKind: "agent",
          kind: "question",
          body,
          options,
        }),
      orgSeats: () => [
        { account: HUMAN, kind: "human_root" as const, parent: null, active: true },
        {
          account: MANAGER,
          kind: "manager_agent" as const,
          parent: HUMAN,
          active: true,
          paused: true,
        },
        { account: worker, kind: "worker_agent" as const, parent: MANAGER, active: true },
      ],
    });
    runtime.onMessage((message) => dualControl.observe(message));
    await dualControl.set({ scope: { level: "workspace" }, mode: "risky_writes" });

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
      dualControl,
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

    const parked = await surface.run({ id: "pr-merge" });
    assert.equal(parked.status, "waiting");
    const review = dualControl.reviews()[0]!;
    assert.equal(review.human, true, "a paused reviewer escalates to a person");
    assert.equal(review.escalated, true);

    const thread = runtime.thread(scopeOfThread(review.threadId) ?? { kind: "org" }, 50);
    const question = thread.find((m) => m.id === review.questionId)!;
    runtime.postMessage({
      scope: scopeOfThread(question.threadId) ?? { kind: "org" },
      author: "ops@example.com",
      authorKind: "human",
      kind: "answer",
      replyTo: question.id,
      body: "concur",
    });
    await dualControl.drain();
    assert.equal(calls.length, 1, "the person released it");
  });
});

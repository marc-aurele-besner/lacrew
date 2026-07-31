/**
 * The operator surface over dual control (F2.32): what a dashboard is served,
 * what a `PUT` may change, and what happens to a tool call made from outside a
 * flow — where there is no run to park, so the caller is told a review opened.
 *
 * Driven through the real app and the real surface: the claim worth testing is
 * behavioural ("the tool route stops too"), and stubbing the checker would
 * assert the wiring rather than the control.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { createDualControl } from "./dualControl.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createOrchestratorApp } from "./httpApp.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { scopeOfThread } from "./conversation.js";
import { CrewRuntime } from "./runtime.js";

const HUMAN = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x2222222222222222222222222222222222222222";

function harness() {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const worker = runtime.defaultAgent.toLowerCase();
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
      { account: MANAGER, kind: "manager_agent" as const, parent: HUMAN, active: true },
      { account: worker, kind: "worker_agent" as const, parent: MANAGER, active: true },
    ],
    onEvent: (event) => runtime.recordAudit(event),
  });
  runtime.onMessage((message) => dualControl.observe(message));
  const model = new MemoryModelProvider();
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows: createFlowsSurface({
      runtime,
      model,
      mcpBackend: {} as McpToolBackend,
      store: createMemoryFlowStore(),
      dualControl,
    }),
    dualControl,
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, runtime, dualControl, worker };
}

const put = (body: Record<string, unknown>) =>
  new Request("http://x/dual-control", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("dual-control routes", () => {
  it("serves the rules, the vocabulary, and the reviewer one seat would get", async () => {
    const h = harness();
    await h.app.request(
      put({ scope: { level: "workspace" }, mode: "spends_and_writes", minSpend: "1000000" }),
    );

    const res = await h.app.request(`/dual-control?as=${h.worker}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      rules: Array<{ mode: string; threshold: { minSpend: string } }>;
      modes: string[];
      reviewers: string[];
      effective: { mode: string; source: { kind: string } };
      reviewer: { accounts: string[]; human: boolean };
    };
    assert.deepEqual(body.modes, ["off", "risky_writes", "spends_and_writes"]);
    assert.ok(body.reviewers.includes("any_peer_in_crew"));
    assert.equal(body.rules[0]?.threshold.minSpend, "1000000");
    assert.equal(body.effective.mode, "spends_and_writes");
    assert.equal(body.effective.source.kind, "rule");
    // Resolved against the live chart, so a dashboard never re-implements the
    // walk up the org tree to say who would be asked.
    assert.deepEqual(body.reviewer.accounts, [MANAGER]);
    assert.equal(body.reviewer.human, false);
  });

  it("refuses a mode, a reviewer or a threshold it cannot enforce", async () => {
    const h = harness();
    const badMode = await h.app.request(put({ scope: { level: "workspace" }, mode: "sometimes" }));
    assert.equal(badMode.status, 400);
    const badReviewer = await h.app.request(
      put({ scope: { level: "workspace" }, mode: "risky_writes", reviewer: "whoever" }),
    );
    assert.equal(badReviewer.status, 400);
    const badSpend = await h.app.request(
      put({ scope: { level: "workspace" }, mode: "spends_and_writes", minSpend: "1.5" }),
    );
    assert.equal(badSpend.status, 400);
    assert.equal(h.dualControl.list().length, 0, "nothing partial was stored");
  });

  it("clearing a scope is not the same as pinning it off", async () => {
    const h = harness();
    await h.app.request(put({ scope: { level: "workspace" }, mode: "risky_writes" }));
    await h.app.request(put({ scope: { level: "agent", ref: h.worker }, mode: "off" }));
    assert.equal(h.dualControl.resolve({ principal: h.worker }).mode, "off");

    // Cleared, the seat falls back to what it inherits rather than staying off.
    const cleared = await h.app.request(put({ scope: { level: "agent", ref: h.worker } }));
    assert.equal(cleared.status, 200);
    assert.equal(h.dualControl.resolve({ principal: h.worker }).mode, "risky_writes");
  });

  it("records who changed it, in both directions", async () => {
    const h = harness();
    await h.app.request(put({ scope: { level: "workspace" }, mode: "risky_writes" }));
    await h.app.request(put({ scope: { level: "workspace" } }));
    const changes = (await h.runtime.audit())
      .filter((e) => e.type === "DualControlChanged")
      .map((e) => (e.payload as { action: string }).action);
    // Turning it down is the direction worth attributing: it is the moment a
    // crew stops needing anyone else's agreement.
    assert.deepEqual(changes.sort(), ["cleared", "set"]);
  });

  it("stops a tool call made outside a flow, and says how to answer it", async () => {
    const h = harness();
    await h.app.request(put({ scope: { level: "workspace" }, mode: "spends_and_writes" }));

    const res = await h.app.request(
      new Request("http://x/mcp/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "lacrew_propose_intent",
          arguments: { agent: h.worker, target: HUMAN, value: "2500000" },
          as: h.worker,
        }),
      }),
    );
    // 202, not 403: the caller is admitted and is waiting on somebody, which is
    // a different thing from "you may not".
    assert.equal(res.status, 202);
    const body = (await res.json()) as { reason: string; reviewId: string; answerVia: string };
    assert.equal(body.reason, "dual_control");
    assert.match(body.answerVia, /concur\|reject/);

    const queue = await (await h.app.request("/dual-control/reviews?status=pending")).json();
    const reviews = (queue as { reviews: Array<{ id: string; tool: string; value: string }> })
      .reviews;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.id, body.reviewId);
    assert.equal(reviews[0]?.tool, "lacrew_propose_intent");
    assert.equal(reviews[0]?.value, "2500000");
  });

  it("answers 503 rather than calling when the surface is not wired", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const model = new MemoryModelProvider();
    const app = createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows: createFlowsSurface({
        runtime,
        model,
        mcpBackend: {} as McpToolBackend,
        store: createMemoryFlowStore(),
      }),
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    });
    const res = await app.request("/dual-control");
    assert.equal(res.status, 503);
  });
});

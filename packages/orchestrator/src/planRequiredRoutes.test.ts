/**
 * The operator surface over plan-required mode (F2.31): what a dashboard is
 * served, what a `PUT` may change, and what happens to a tool call made from
 * outside a flow.
 *
 * Driven through the real app and the real surface — the claim worth testing is
 * behavioural ("the tool route refuses too"), and stubbing the checker would
 * assert the wiring rather than the control.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createOrchestratorApp } from "./httpApp.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { createPlanRequirements } from "./planRequired.js";
import { scopeOfThread } from "./conversation.js";
import { CrewRuntime } from "./runtime.js";

function harness() {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const planRequired = createPlanRequirements({
    messagesIn: (threadId) => runtime.thread(scopeOfThread(threadId) ?? { kind: "org" }, 200),
    onEvent: (event) => runtime.recordAudit(event),
  });
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
      planRequired,
    }),
    planRequired,
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, runtime, planRequired };
}

const put = (body: Record<string, unknown>) =>
  new Request("http://x/plan-required", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("plan-required routes", () => {
  it("serves the rules, the vocabulary, and what one seat actually runs under", async () => {
    const h = harness();
    await h.app.request(put({ scope: { level: "workspace" }, mode: "side_effects" }));

    const res = await h.app.request(`/plan-required?as=${h.runtime.defaultAgent}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      rules: Array<{ mode: string }>;
      modes: string[];
      effective: { mode: string; windowMs: number; source: { kind: string } };
    };
    assert.deepEqual(body.modes, ["off", "spends_only", "side_effects"]);
    assert.equal(body.rules.length, 1);
    // Resolved the way a call would resolve it, so an inherited setting is
    // legible without a dashboard re-implementing precedence.
    assert.equal(body.effective.mode, "side_effects");
    assert.equal(body.effective.source.kind, "rule");
  });

  it("refuses a mode nobody defined, and a window that bounds nothing", async () => {
    const h = harness();
    const bad = await h.app.request(put({ scope: { level: "workspace" }, mode: "always" }));
    assert.equal(bad.status, 400);
    const window = await h.app.request(
      put({ scope: { level: "workspace" }, mode: "side_effects", windowMs: 1_000 }),
    );
    assert.equal(window.status, 400);
    assert.match(((await window.json()) as { error: string }).error, /windowMs/);

    const noScope = await h.app.request(put({ mode: "off" }));
    assert.equal(noScope.status, 400);
  });

  it("clearing a rule is not the same as pinning it off", async () => {
    const h = harness();
    await h.app.request(put({ scope: { level: "workspace" }, mode: "spends_only" }));
    const cleared = await h.app.request(put({ scope: { level: "workspace" } }));
    assert.equal(cleared.status, 200);
    const body = (await cleared.json()) as { cleared: boolean; rules: unknown[] };
    assert.equal(body.cleared, true);
    assert.equal(body.rules.length, 0);
    assert.equal(h.planRequired.resolve().source.kind, "default");
  });

  it("refuses a propose made outside a flow, and lets it through once planned", async () => {
    const h = harness();
    await h.app.request(put({ scope: { level: "workspace" }, mode: "spends_only" }));

    const call = () =>
      h.app.request("http://x/mcp/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "lacrew_propose_intent",
          arguments: { agent: h.runtime.defaultAgent, target: h.runtime.defaultAgent, value: "1" },
        }),
      });

    const blocked = await call();
    // 409, not 403: the caller is admitted to do this and is missing a step,
    // which is a different fix from "you may not".
    assert.equal(blocked.status, 409);
    assert.match(((await blocked.json()) as { error: string }).error, /^plan_required:/);
    assert.ok(
      (await h.runtime.audit()).some((e) => e.type === "PlanRequiredBlocked"),
      "the attempt left a row",
    );

    h.runtime.postMessage({
      scope: { kind: "agent", account: h.runtime.defaultAgent },
      author: h.runtime.defaultAgent,
      authorKind: "agent",
      kind: "plan",
      body: "Paying the weekly data bill: 1 unit to the desk's own address.",
    });

    // The plan gets it past the requirement and no further: what answers now is
    // the policy stack, which is the invariant this whole feature rests on — a
    // plan is a claim, never an approval.
    const planned = await call();
    assert.notEqual(planned.status, 409);
    assert.match(((await planned.json()) as { error?: string }).error ?? "", /Policy DENY/);
  });

  it("answers 503 where no requirement surface is wired", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const model = new MemoryModelProvider();
    const app = createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows: createFlowsSurface({ runtime, model, store: createMemoryFlowStore() }),
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    });
    const res = await app.request("/plan-required");
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, "plan_required_unavailable");
  });
});

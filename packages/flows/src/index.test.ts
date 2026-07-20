import assert from "node:assert/strict";
import { test } from "node:test";
import { flow } from "./builder.js";
import { flowRunSnippet, flowToCode } from "./codegen.js";
import { createMockFlowBackend, interpolate, runFlow } from "./run.js";
import { flowTemplates } from "./templates.js";
import { validateFlow } from "./validate.js";
import type { FlowDefinition } from "./types.js";

test("builder chains steps and build() validates", () => {
  const def = flow("demo", "Demo")
    .describe("test flow")
    .tool("org", "lacrew_get_org_tree")
    .model("sum", { prompt: "Summarize {{steps.org.json}}" })
    .build();
  assert.equal(def.steps.length, 2);
  assert.equal(def.steps[0]!.kind, "tool");
  assert.ok(validateFlow(def).ok);
});

test("validateFlow rejects duplicates, bad edges, and cycles", () => {
  const dup = validateFlow({
    id: "x",
    name: "x",
    steps: [
      { id: "a", kind: "tool", tool: "t" },
      { id: "a", kind: "tool", tool: "t" },
    ],
  });
  assert.ok(!dup.ok);
  assert.ok(dup.errors.some((e) => e.includes("duplicate")));

  const badEdge = validateFlow({
    id: "x",
    name: "x",
    steps: [{ id: "a", kind: "tool", tool: "t", next: "missing" }],
  });
  assert.ok(!badEdge.ok);

  const cyclic: FlowDefinition = {
    id: "x",
    name: "x",
    steps: [
      { id: "a", kind: "tool", tool: "t", next: "b" },
      { id: "b", kind: "tool", tool: "t", next: "a" },
    ],
  };
  const cycle = validateFlow(cyclic);
  assert.ok(!cycle.ok);
  assert.ok(cycle.errors.some((e) => e.includes("cycle")));
});

test("interpolate resolves input and step outputs", () => {
  const out = interpolate("in={{input}} t={{steps.a.text}} v={{steps.a.verdict}} x={{nope}}", {
    input: "hello",
    steps: { a: { text: "T", verdict: "ALLOW" } },
  });
  assert.equal(out, "in=hello t=T v=ALLOW x=");
});

test("runFlow executes tools, models, and gate branching (mock backend)", async () => {
  const def = flow("gated", "Gated")
    .gate("spend", { value: "75000000", onAllow: "ok", onEscalate: "esc" })
    .model("ok", { prompt: "allowed {{steps.spend.verdict}}", next: null })
    .model("esc", { prompt: "escalated", next: null })
    .build();

  const allowRun = await runFlow(def, createMockFlowBackend(), { mocked: true });
  assert.equal(allowRun.status, "completed");
  assert.deepEqual(
    allowRun.steps.map((s) => s.stepId),
    ["spend", "ok"],
  );
  assert.equal(allowRun.steps[0]!.verdict, "ALLOW");
  assert.ok((allowRun.steps[1]!.output as { text: string }).text.includes("ALLOW"));

  const bigDef = flow("gated-big", "Gated big")
    .gate("spend", { value: "150000000", onAllow: "ok", onEscalate: "esc" })
    .model("ok", { prompt: "allowed", next: null })
    .model("esc", { prompt: "escalated", next: null })
    .build();
  const escRun = await runFlow(bigDef, createMockFlowBackend());
  assert.equal(escRun.steps[0]!.verdict, "ESCALATE");
  assert.deepEqual(
    escRun.steps.map((s) => s.stepId),
    ["spend", "esc"],
  );
});

test("runFlow branch step routes on contains", async () => {
  const def = flow("branchy", "Branchy")
    .model("say", { prompt: "reply" })
    .branch("check", {
      when: { source: "{{steps.say.text}}", op: "contains", value: "mock" },
      onTrue: "yes",
      onFalse: "no",
    })
    .model("yes", { prompt: "was mock", next: null })
    .model("no", { prompt: "was real", next: null })
    .build();
  const run = await runFlow(def, createMockFlowBackend());
  assert.equal(run.status, "completed");
  assert.deepEqual(
    run.steps.map((s) => s.stepId),
    ["say", "check", "yes"],
  );
});

test("runFlow switch hits matching case", async () => {
  const def = flow("sw2", "SW2")
    .model("say", { prompt: "x" })
    .switch("route", {
      when: { source: "{{steps.say.text}}" },
      cases: [{ value: "[mock model] x", next: "hit" }],
      onDefault: "miss",
    })
    .model("hit", { prompt: "hit", next: null })
    .model("miss", { prompt: "miss", next: null })
    .build();
  const run = await runFlow(def, createMockFlowBackend());
  assert.equal(run.status, "completed");
  assert.deepEqual(
    run.steps.map((s) => s.stepId),
    ["say", "route", "hit"],
  );
});

test("runFlow switch uses onDefault when no case matches", async () => {
  const def = flow("sw3", "SW3")
    .model("say", { prompt: "x" })
    .switch("route", {
      when: { source: "{{steps.say.text}}" },
      cases: [{ value: "APPROVE", next: "hit" }],
      onDefault: "miss",
    })
    .model("hit", { prompt: "hit", next: null })
    .model("miss", { prompt: "miss", next: null })
    .build();
  const run = await runFlow(def, createMockFlowBackend());
  assert.equal(run.status, "completed");
  assert.deepEqual(
    run.steps.map((s) => s.stepId),
    ["say", "route", "miss"],
  );
});

test("validateFlow reports an unknown step kind instead of throwing", () => {
  // Flows arrive as JSON from builders and marketplace listings, so the
  // FlowStep union is not a runtime guarantee.
  const result = validateFlow({
    id: "x",
    name: "x",
    steps: [{ id: "a", kind: "prompt" }],
  } as unknown as FlowDefinition);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('unknown kind "prompt"')));
});

test("runFlow rejects an unknown step kind with a trace, not a throw", async () => {
  const run = await runFlow(
    { id: "x", name: "x", steps: [{ id: "a", kind: "prompt" }] } as unknown as FlowDefinition,
    createMockFlowBackend(),
  );
  assert.equal(run.status, "error");
  assert.ok(run.steps[0]!.error?.includes("unknown kind"));
});

test("runFlow surfaces step errors without throwing", async () => {
  const def = flow("broken", "Broken").tool("bad", "no_such_tool").build();
  const run = await runFlow(def, createMockFlowBackend());
  assert.equal(run.status, "error");
  assert.equal(run.steps[0]!.status, "error");
  assert.ok(run.steps[0]!.error?.includes("no_such_tool"));
});

test("runFlow rejects invalid definitions with a trace, not a throw", async () => {
  const run = await runFlow(
    { id: "x", name: "x", steps: [{ id: "a", kind: "tool", tool: "t", next: "missing" }] },
    createMockFlowBackend(),
  );
  assert.equal(run.status, "error");
  assert.ok(run.steps[0]!.error?.includes("unknown step"));
});

test("all shipped templates validate and run on the mock backend", async () => {
  assert.ok(flowTemplates.length >= 4);
  for (const tpl of flowTemplates) {
    const check = validateFlow(tpl.definition);
    assert.ok(check.ok, `${tpl.id}: ${check.errors.join("; ")}`);
    const run = await runFlow(tpl.definition, createMockFlowBackend(), {
      input: "unit test",
      mocked: true,
    });
    assert.equal(run.status, "completed", `${tpl.id} run: ${JSON.stringify(run.steps)}`);
    assert.ok(run.steps.length >= 2, tpl.id);
  }
});

test("flowToCode round-trips through the builder API shape", () => {
  // By id, not index — template order is not part of the contract.
  const def = flowTemplates.find((t) => t.id === "tpl-budget-guarded-spend")!.definition;
  const code = flowToCode(def);
  assert.ok(code.includes(`import { flow } from "@lacrew/flows";`));
  assert.ok(code.includes(`.gate("spend"`));
  assert.ok(code.includes(`onEscalate: "po-note"`));
  assert.ok(code.trimEnd().endsWith(";"));
  const snippet = flowRunSnippet(def);
  assert.ok(snippet.includes("createFlowsClient"));
});

const AGENT_A = "0x1111111111111111111111111111111111111111";
const AGENT_B = "0x2222222222222222222222222222222222222222";

test("scope defaults to org-wide and validates refs for team/agent", () => {
  const orgWide = flow("s1", "S1").model("m", { prompt: "hi", next: null }).build();
  assert.equal(orgWide.scope, undefined);

  const team = flow("s2", "S2")
    .scope("team", AGENT_A)
    .model("m", { prompt: "hi", next: null })
    .build();
  assert.deepEqual(team.scope, { level: "team", ref: AGENT_A });

  const missingRef = validateFlow({
    id: "s3",
    name: "S3",
    scope: { level: "agent" },
    steps: [{ id: "m", kind: "model", prompt: "hi", next: null }],
  });
  assert.equal(missingRef.ok, false);
  assert.ok(missingRef.errors.some((e) => e.includes("scope.ref")));

  const badLevel = validateFlow({
    id: "s4",
    name: "S4",
    scope: { level: "department" as never },
    steps: [{ id: "m", kind: "model", prompt: "hi", next: null }],
  });
  assert.equal(badLevel.ok, false);
  assert.ok(badLevel.errors.some((e) => e.includes("unknown scope level")));
});

test("org step escalates to a proposal and routes on the verdict", async () => {
  const def = flow("orgy", "Orgy")
    .org("promote", {
      action: "set-cap",
      node: AGENT_A,
      cap: "500000000",
      onAllow: "done",
      onEscalate: "waiting",
    })
    .model("done", { prompt: "applied", next: null })
    .model("waiting", { prompt: "proposal {{steps.promote.verdict}}", next: null })
    .build();

  const run = await runFlow(def, createMockFlowBackend());
  assert.equal(run.status, "completed");
  // Structural changes are constitutional, so the mock always escalates.
  assert.equal(run.steps[0]!.verdict, "ESCALATE");
  assert.deepEqual(
    run.steps.map((s) => s.stepId),
    ["promote", "waiting"],
  );
  assert.ok((run.steps[0]!.output as { proposalId: string }).proposalId);
});

test("budget step writes directly under cap and proposes above it", async () => {
  const build = (amount: string) =>
    flow(`b-${amount}`, "Budget")
      .budget("raise", {
        action: "set-grant",
        node: AGENT_B,
        amount,
        onAllow: "ok",
        onEscalate: "vote",
      })
      .model("ok", { prompt: "written", next: null })
      .model("vote", { prompt: "proposed", next: null })
      .build();

  const under = await runFlow(build("50000000"), createMockFlowBackend());
  assert.equal(under.steps[0]!.verdict, "ALLOW");
  assert.equal(under.steps[1]!.stepId, "ok");
  assert.ok((under.steps[0]!.output as { txHash: string }).txHash);

  const over = await runFlow(build("500000000"), createMockFlowBackend());
  assert.equal(over.steps[0]!.verdict, "ESCALATE");
  assert.equal(over.steps[1]!.stepId, "vote");
  assert.ok((over.steps[0]!.output as { proposalId: string }).proposalId);
});

test("agent and governance steps run and expose their output", async () => {
  const def = flow("deleg", "Delegate")
    .agent("ask", { action: "invoke", agent: AGENT_A, prompt: "review this" })
    .governance("cast", { action: "vote", proposalId: "7", support: true, next: null })
    .build();

  const run = await runFlow(def, createMockFlowBackend());
  assert.equal(run.status, "completed");
  assert.ok((run.steps[0]!.output as { text: string }).text.includes(AGENT_A));
  assert.equal((run.steps[1]!.output as { proposalId: string }).proposalId, "7");
});

test("validateFlow rejects malformed org, budget, and governance steps", () => {
  const result = validateFlow({
    id: "bad",
    name: "Bad",
    steps: [
      { id: "o", kind: "org", action: "reparent", node: "not-an-address", next: null } as never,
      { id: "b", kind: "budget", action: "teleport", node: AGENT_A } as never,
      { id: "g", kind: "governance", action: "vote" } as never,
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("must be a 0x address")));
  assert.ok(result.errors.some((e) => e.includes(`org step "o" parent is required`)));
  assert.ok(result.errors.some((e) => e.includes("unknown action \"teleport\"")));
  assert.ok(result.errors.some((e) => e.includes("needs a proposalId")));
});

test("runFlow records the principal it executed as", async () => {
  const def = flow("who", "Who").gate("spend", { value: "1", onAllow: null }).build();
  const run = await runFlow(def, createMockFlowBackend(), {
    principal: { agent: AGENT_B, nodeKind: "worker_agent" },
  });
  assert.deepEqual(run.principal, { agent: AGENT_B, nodeKind: "worker_agent" });
});

test("flowToCode emits scope, schedule, and the new step kinds", () => {
  const def = flow("coded", "Coded")
    .trigger("cron")
    .schedule("0 9 * * 1-5")
    .scope("team", AGENT_A)
    .budget("raise", { action: "set-grant", node: AGENT_B, amount: "1000" })
    .governance("go", { action: "execute", proposalId: "3", next: null })
    .build();
  const code = flowToCode(def);
  assert.ok(code.includes(`.schedule("0 9 * * 1-5")`));
  assert.ok(code.includes(`.scope("team", "${AGENT_A}")`));
  assert.ok(code.includes(`.budget("raise"`));
  assert.ok(code.includes(`.governance("go"`));
});

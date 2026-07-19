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
  const def = flowTemplates[1]!.definition;
  const code = flowToCode(def);
  assert.ok(code.includes(`import { flow } from "@lacrew/flows";`));
  assert.ok(code.includes(`.gate("spend"`));
  assert.ok(code.includes(`onEscalate: "po-note"`));
  assert.ok(code.trimEnd().endsWith(";"));
  const snippet = flowRunSnippet(def);
  assert.ok(snippet.includes("createFlowsClient"));
});

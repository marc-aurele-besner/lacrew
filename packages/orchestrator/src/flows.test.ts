import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow, flowTemplates } from "@lacrew/flows";
import { createFlowsSurface } from "./flows.js";
import { MemoryModelProvider } from "./model/index.js";
import { CrewRuntime } from "./runtime.js";

function makeSurface() {
  const runtime = new CrewRuntime();
  // No mcpBackend → detached mock backend (offline-safe test path).
  return {
    runtime,
    surface: createFlowsSurface({ runtime, model: new MemoryModelProvider() }),
  };
}

describe("flows surface", () => {
  it("saves, lists, and removes definitions with validation", () => {
    const { surface } = makeSurface();
    const def = flow("t", "Test").tool("org", "lacrew_get_org_tree").build();
    surface.save(def);
    assert.equal(surface.list().length, 1);
    assert.throws(
      () => surface.save({ id: "bad", name: "", steps: [] }),
      /invalid_flow/,
    );
    assert.ok(surface.remove("t"));
    assert.equal(surface.list().length, 0);
  });

  it("runs a saved flow, keeps the run ring, and records audit events", async () => {
    const { runtime, surface } = makeSurface();
    const def = flowTemplates[0]!.definition;
    surface.save(def);
    const run = await surface.run({ id: def.id, input: "test" });
    assert.equal(run.status, "completed");
    assert.ok(run.mocked);
    assert.ok(run.steps.length >= 2);
    assert.equal(surface.runs()[0]!.runId, run.runId);

    const audit = await runtime.audit();
    assert.ok(audit.some((e) => e.type === "FlowSaved"));
    assert.ok(audit.some((e) => e.type === "FlowRun"));
  });

  it("runs an unsaved definition directly and 404s unknown ids", async () => {
    const { surface } = makeSurface();
    const def = flow("adhoc", "Adhoc").model("m", { prompt: "hi {{input}}" }).build();
    const run = await surface.run({ flow: def, input: "there" });
    assert.equal(run.status, "completed");
    await assert.rejects(surface.run({ id: "nope" }), /flow_not_found/);
  });

  it("ships the template catalog", () => {
    const { surface } = makeSurface();
    assert.ok(surface.templates().length >= 4);
  });
});

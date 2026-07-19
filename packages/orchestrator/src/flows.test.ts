import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow, flowTemplates, type FlowDefinition, type FlowRunResult } from "@lacrew/flows";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore, type FlowStore } from "./flowStore.js";
import { MemoryModelProvider } from "./model/index.js";
import { CrewRuntime } from "./runtime.js";

function makeSurface(store?: FlowStore) {
  const runtime = new CrewRuntime();
  // No mcpBackend → detached mock backend (offline-safe test path).
  return {
    runtime,
    surface: createFlowsSurface({ runtime, model: new MemoryModelProvider(), store }),
  };
}

/** In-memory FlowStore that actually remembers (persistence assertions). */
function recordingStore() {
  const defs = new Map<string, FlowDefinition>();
  const runs: FlowRunResult[] = [];
  const store: FlowStore = {
    name: "recording",
    save: async (def) => {
      defs.set(def.id, def);
    },
    remove: async (id) => {
      defs.delete(id);
    },
    list: async () => [...defs.values()],
    appendRun: async (run) => {
      runs.push(run);
    },
    recentRuns: async (limit) => [...runs].reverse().slice(0, limit),
    close: async () => {},
  };
  return { store, defs, runs };
}

describe("flows surface", () => {
  it("saves, lists, and removes definitions with validation", async () => {
    const { surface } = makeSurface(createMemoryFlowStore());
    const def = flow("t", "Test").tool("org", "lacrew_get_org_tree").build();
    await surface.save(def);
    assert.equal(surface.list().length, 1);
    await assert.rejects(surface.save({ id: "bad", name: "", steps: [] }), /invalid_flow/);
    assert.ok(await surface.remove("t"));
    assert.equal(surface.list().length, 0);
  });

  it("runs a saved flow, keeps the run ring, and records audit events", async () => {
    const { runtime, surface } = makeSurface();
    const def = flowTemplates[0]!.definition;
    await surface.save(def);
    const run = await surface.run({ id: def.id, input: "test" });
    assert.equal(run.status, "completed");
    assert.ok(run.mocked);
    assert.equal(run.trigger, "manual");
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

  it("persists definitions + runs through the store and hydrates them back", async () => {
    const { store, defs, runs } = recordingStore();
    const first = makeSurface(store);
    const def = flow("keep", "Keeper").model("m", { prompt: "hello" }).build();
    await first.surface.save(def);
    await first.surface.run({ id: "keep" });
    assert.equal(defs.size, 1);
    assert.equal(runs.length, 1);

    // A fresh surface over the same store sees the saved flow and run history.
    const second = makeSurface(store);
    const counts = await second.surface.hydrate();
    assert.deepEqual(counts, { flows: 1, runs: 1 });
    assert.equal(second.surface.list()[0]!.id, "keep");
    assert.equal(second.surface.runs()[0]!.flowId, "keep");
  });

  it("runTriggered runs only epoch-triggered flows and tags the trigger", async () => {
    const { surface } = makeSurface();
    await surface.save(flow("auto", "Auto").trigger("epoch").model("m", { prompt: "tick" }).build());
    await surface.save(flow("hand", "Hand").model("m", { prompt: "manual only" }).build());
    const results = await surface.runTriggered("epoch");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.flowId, "auto");
    assert.equal(results[0]!.trigger, "epoch");
  });

  it("ships the template catalog with the epoch-triggered pulse", () => {
    const { surface } = makeSurface();
    assert.ok(surface.templates().length >= 4);
    const pulse = surface.templates().find((t) => t.id === "tpl-treasury-pulse");
    assert.equal(pulse?.definition.trigger, "epoch");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow, flowTemplates, type FlowDefinition, type FlowRunResult } from "@lacrew/flows";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore, type FlowStore } from "./flowStore.js";
import { MemoryModelProvider } from "./model/index.js";
import { CrewRuntime } from "./runtime.js";
import { createLacrewClient } from "@lacrew/sdk/testing";

function makeSurface(store?: FlowStore) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  // No mcpBackend → detached mock backend (offline-safe test path).
  // The store is always explicit: defaulting to createFlowStoreFromEnv would
  // make these unit tests hit Postgres on any machine with DATABASE_URL set,
  // exercising a different code path and leaving an open pool behind.
  return {
    runtime,
    surface: createFlowsSurface({
      runtime,
      model: new MemoryModelProvider(),
      store: store ?? createMemoryFlowStore(),
    }),
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
    assert.equal((await surface.list()).length, 1);
    await assert.rejects(surface.save({ id: "bad", name: "", steps: [] }), /invalid_flow/);
    assert.ok(await surface.remove("t"));
    assert.equal((await surface.list()).length, 0);
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
    assert.equal((await second.surface.list())[0]!.id, "keep");
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

  it("fires cron flows once per matching minute", async () => {
    const { surface } = makeSurface();
    await surface.save(
      flow("cron-pulse", "Cron pulse")
        .model("say", { prompt: "ping" })
        .build(),
    );
    const def = (await surface.list()).find((f) => f.id === "cron-pulse")!;
    await surface.save({ ...def, trigger: "cron", schedule: "*/5 * * * *" });

    const matching = new Date(Date.UTC(2026, 6, 20, 12, 10)); // :10 matches */5
    const first = await surface.runCronDue(matching);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.trigger, "cron");

    // Same minute → no double fire.
    assert.equal((await surface.runCronDue(matching)).length, 0);

    // Non-matching minute → nothing.
    const off = new Date(Date.UTC(2026, 6, 20, 12, 12));
    assert.equal((await surface.runCronDue(off)).length, 0);

    // Next matching minute fires again.
    const next = new Date(Date.UTC(2026, 6, 20, 12, 15));
    assert.equal((await surface.runCronDue(next)).length, 1);
  });

  it("rejects cron flows without a valid schedule", async () => {
    const { surface } = makeSurface();
    const def = flow("cron-bad", "Cron bad").model("say", { prompt: "x" }).build();
    await assert.rejects(
      () => surface.save({ ...def, trigger: "cron", schedule: "not-a-cron" }),
      /valid 5-field schedule/,
    );
  });
});


/** Surface with a live-shaped MCP backend, so `agent` steps route to delegate. */
function makeDelegatingSurface() {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const stub = {
    getOrgTree: async () => [],
    listPendingIntents: async () => [],
    proposeIntent: async () => ({ verdict: "ALLOW" }),
    resolveIntent: async () => ({}),
  };
  return createFlowsSurface({
    runtime,
    model: new MemoryModelProvider(),
    mcpBackend: stub,
    store: createMemoryFlowStore(),
  });
}

const DELEGATE = "0x1111111111111111111111111111111111111111";

describe("flow delegation guards", () => {
  it("refuses a flow that delegates back into itself", async () => {
    // validateFlow only rejects cycles between a flow's own edges; a flowId
    // reference is invisible to it, so an unguarded self-delegation would
    // recurse until the process dies.
    const surface = makeDelegatingSurface();
    await surface.save({
      id: "loop",
      name: "Loop",
      steps: [
        { id: "again", kind: "agent", action: "invoke", agent: DELEGATE, flowId: "loop", next: null },
      ],
    });
    const run = await surface.run({ id: "loop" });
    assert.equal(run.status, "error");
    assert.match(run.steps[0]!.error ?? "", /flow_delegation_cycle/);
  });

  it("refuses an indirect delegation cycle", async () => {
    const surface = makeDelegatingSurface();
    for (const [id, target] of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      await surface.save({
        id: id!,
        name: id!,
        steps: [
          { id: "go", kind: "agent", action: "invoke", agent: DELEGATE, flowId: target!, next: null },
        ],
      });
    }
    const run = await surface.run({ id: "a" });
    assert.equal(run.status, "error");
    // Surfaces through the delegate wrapper, naming the cycle underneath.
    assert.match(run.steps[0]!.error ?? "", /flow_delegate_failed|flow_delegation_cycle/);
  });

  it("bounds acyclic delegation depth", async () => {
    const surface = makeDelegatingSurface();
    // A chain longer than MAX_DELEGATION_DEPTH: no cycle, but still unbounded work.
    const ids = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];
    for (let i = 0; i < ids.length; i += 1) {
      const next = ids[i + 1];
      await surface.save({
        id: ids[i]!,
        name: ids[i]!,
        steps: next
          ? [{ id: "go", kind: "agent", action: "invoke", agent: DELEGATE, flowId: next, next: null }]
          : [{ id: "done", kind: "model", prompt: "end", next: null }],
      });
    }
    const run = await surface.run({ id: "d0" });
    assert.equal(run.status, "error");
    assert.match(run.steps[0]!.error ?? "", /flow_delegate_failed|flow_delegation_too_deep/);
  });

  it("allows delegation within the depth bound", async () => {
    const surface = makeDelegatingSurface();
    await surface.save({
      id: "leaf",
      name: "Leaf",
      steps: [{ id: "done", kind: "model", prompt: "leaf work", next: null }],
    });
    await surface.save({
      id: "root",
      name: "Root",
      steps: [
        { id: "go", kind: "agent", action: "invoke", agent: DELEGATE, flowId: "leaf", next: null },
      ],
    });
    const run = await surface.run({ id: "root" });
    assert.equal(run.status, "completed");
    assert.equal((run.steps[0]!.output as { status: string }).status, "completed");
  });
});

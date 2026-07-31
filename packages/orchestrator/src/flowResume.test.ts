/**
 * Durable pause / resume / checkpoints end to end (F2.26).
 *
 * The claim under test is behavioural and expensive to get wrong: a run that
 * survives the process it started in must not pay, write, or delegate twice.
 * So the connector network is stubbed and *counted*, and a "crash" is produced
 * the way a real one leaves state behind — the call goes out, and nothing after
 * it is recorded — rather than by asserting on the recovery code's intentions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flow } from "@lacrew/flows";
import type { FlowCheckpoint } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { createConnectorModes } from "./connectorPolicy.js";
import { createConnectorRegistry, type Connector } from "./connectors.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore, type FlowStore } from "./flowStore.js";
import { createOrchestratorApp } from "./httpApp.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { CrewRuntime } from "./runtime.js";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";

const github: Connector = {
  id: "github",
  baseUrl: "https://api.github.com",
  auth: { kind: "bearer", tokenEnv: "GH_TOKEN" },
  routes: [
    {
      name: "get_pull_request",
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls/{number}",
      effect: "read",
    },
    {
      name: "merge_pull_request",
      method: "PUT",
      path: "/repos/{owner}/{repo}/pulls/{number}/merge",
      effect: "write",
      mode: "auto",
    },
  ],
};

/**
 * A store that stops recording partway through, which is all a killed process
 * looks like from the outside: the last call it made still went out, and
 * nothing it would have written afterwards ever landed. The throw from
 * `checkpoint` is what stops the run, standing in for the process ending.
 */
function crashingStore(when: { onAttemptAt?: string; afterSeq?: number }): {
  store: FlowStore;
  /** The next process, reading the same durable state the dead one left. */
  revive: () => void;
} {
  const inner = createMemoryFlowStore();
  let dead = false;
  /** The process only dies once; the one that replaces it runs normally. */
  let armed = true;
  const store: FlowStore = {
    ...inner,
    setAttempt: async (runId, attempt) => {
      if (dead) return;
      await inner.setAttempt(runId, attempt);
      if (armed && attempt && attempt.stepId === when.onAttemptAt) dead = true;
    },
    checkpoint: async (cp) => {
      if (dead) throw new Error("process_killed");
      await inner.checkpoint(cp);
      if (armed && when.afterSeq !== undefined && cp.seq >= when.afterSeq) dead = true;
    },
    appendRun: async (run) => {
      if (dead) return;
      await inner.appendRun(run);
    },
  };
  return {
    store,
    revive: () => {
      dead = false;
      armed = false;
    },
  };
}

function harness(store: FlowStore) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const connectors = createConnectorRegistry({
    connectors: [github],
    env: { GH_TOKEN: "ghp_secret" },
    fetchImpl,
    checkPolicy: async () => "ALLOW",
    resolveMode: (route, id, subject) => createConnectorModes({}).resolve(route, id, subject),
  });

  const surface = createFlowsSurface({
    runtime,
    model: new MemoryModelProvider(),
    // Any backend flips the surface off its detached mock and onto the live
    // dispatch path, which is where connector routes are actually reached.
    mcpBackend: {} as McpToolBackend,
    store,
    connectors,
  });
  return { runtime, surface, calls };
}

const args = { owner: "lacrew", repo: "lacrew", number: "7" };

function prFlow(opts: { idempotentMerge?: boolean } = {}) {
  return flow("pr-merge", "Merge a PR")
    .tool("read", "github.get_pull_request", args)
    .tool("merge", "github.merge_pull_request", args, {
      ...(opts.idempotentMerge ? { idempotent: true } : {}),
    })
    .model("report", { prompt: "Merged: {{steps.merge.text}}" })
    .build();
}

const merges = (calls: string[]): number => calls.filter((c) => c.includes("/merge")).length;

describe("durable flow resume", () => {
  it("checkpoints every completed step with a cursor a resume can use", async () => {
    const store = createMemoryFlowStore();
    const { surface } = harness(store);
    await surface.save(prFlow());
    const run = await surface.run({ id: "pr-merge", input: "pr-7" });
    assert.equal(run.status, "completed");

    const trail = await surface.checkpoints(run.runId);
    assert.deepEqual(
      trail.map((c: FlowCheckpoint) => [c.seq, c.stepId, c.nextStepId]),
      [
        [1, "read", "merge"],
        [2, "merge", "report"],
        [3, "report", null],
      ],
    );
    const state = await surface.runState(run.runId);
    assert.equal(state?.status, "completed");
    assert.equal(state?.attempt, null, "nothing is left in flight");
  });

  it("resumes a crashed run without re-calling a write that already happened", async () => {
    // Killed after the merge was checkpointed: the write is done, the report is
    // not, and the cursor says so.
    const { store, revive } = crashingStore({ afterSeq: 2 });
    const first = harness(store);
    await first.surface.save(prFlow());
    await first.surface.run({ id: "pr-merge", input: "pr-7" });
    assert.equal(merges(first.calls), 1);

    // A fresh process over the same store — the memory store keeps run state
    // but not definitions, so this replica saves the flow as a pg one would
    // have hydrated it.
    revive();
    const second = harness(store);
    await second.surface.save(prFlow());
    const recovered = await second.surface.hydrateRuns();

    assert.deepEqual(recovered, { resumed: 1, failed: 0, paused: 0 });
    assert.equal(merges(second.calls), 0, "the completed write is not repeated");
    const finished = second.surface.runs()[0];
    assert.equal(finished?.status, "completed");
    assert.deepEqual(
      finished?.steps.map((s) => `${s.stepId}:${s.status}`),
      ["read:ok", "merge:ok", "report:ok"],
    );
  });

  it("fails a run closed when it died mid-write rather than retrying the call", async () => {
    const { store, revive } = crashingStore({ onAttemptAt: "merge" });
    const first = harness(store);
    await first.surface.save(prFlow());
    await first.surface.run({ id: "pr-merge", input: "pr-7" });
    assert.equal(merges(first.calls), 1, "the call did go out — that is the problem");

    revive();
    const second = harness(store);
    await second.surface.save(prFlow());
    const recovered = await second.surface.hydrateRuns();

    assert.deepEqual(recovered, { resumed: 0, failed: 1, paused: 0 });
    assert.equal(merges(second.calls), 0, "a write nobody recorded is never redone blindly");
    const failed = second.surface.runs()[0];
    assert.equal(failed?.status, "error");
    assert.match(String(failed?.steps.at(-1)?.error), /incomplete_write_attempt:merge/);
    // The attempt key is what an operator reconciles against.
    assert.match(String(failed?.steps.at(-1)?.error), /merge:2/);
  });

  it("re-enters a step that declares repeating it is safe", async () => {
    const { store, revive } = crashingStore({ onAttemptAt: "merge" });
    const first = harness(store);
    await first.surface.save(prFlow({ idempotentMerge: true }));
    await first.surface.run({ id: "pr-merge", input: "pr-7" });
    assert.equal(merges(first.calls), 1);

    revive();
    const second = harness(store);
    await second.surface.save(prFlow({ idempotentMerge: true }));
    const recovered = await second.surface.hydrateRuns();

    assert.deepEqual(recovered, { resumed: 1, failed: 0, paused: 0 });
    assert.equal(merges(second.calls), 1, "the step said a repeat is harmless, so it repeats");
    assert.equal(second.surface.runs()[0]?.status, "completed");
  });

  it("pauses a run in flight at the next step boundary, then resumes it", async () => {
    const store = createMemoryFlowStore();
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const calls: string[] = [];
    let pauseNext: (() => Promise<void>) | null = null;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      // Another replica (or a person) asks for the pause while the read is
      // still in the air; it is honoured before the merge, not during it.
      await pauseNext?.();
      pauseNext = null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const connectors = createConnectorRegistry({
      connectors: [github],
      env: { GH_TOKEN: "ghp_secret" },
      fetchImpl,
      checkPolicy: async () => "ALLOW",
      resolveMode: (route, id, subject) => createConnectorModes({}).resolve(route, id, subject),
    });
    const surface = createFlowsSurface({
      runtime,
      model: new MemoryModelProvider(),
      mcpBackend: {} as McpToolBackend,
      store,
      connectors,
    });
    await surface.save(prFlow());

    const runId = "run-pause-1";
    pauseNext = async () => {
      await surface.pause(runId, "checking something");
    };
    const paused = await surface.run({ id: "pr-merge", runId, input: "pr-7" });

    assert.equal(paused.status, "waiting");
    assert.equal(paused.waiting?.reason, "operator");
    assert.equal(paused.waiting?.stepId, "merge");
    assert.equal(merges(calls), 0, "the pause landed before the write, not inside it");
    assert.equal((await surface.runState(runId))?.status, "waiting");

    const resumed = await surface.resume(runId);
    assert.equal(resumed.status, "completed");
    assert.equal(merges(calls), 1, "the merge ran exactly once across the pause");
    assert.equal(
      surface.runs().filter((r) => r.runId === runId).length,
      1,
      "the resumed run replaces its own paused entry rather than appearing twice",
    );
  });

  it("refuses to resume a cancelled run, and refuses to cancel a finished one", async () => {
    const store = createMemoryFlowStore();
    const { surface } = harness(store);
    const gated = flow("signoff", "Sign-off")
      .model("draft", { prompt: "draft {{input}}" })
      .wait("hold", { detail: "a human signs off" })
      .model("done", { prompt: "done" })
      .build();
    await surface.save(gated);

    const paused = await surface.run({ id: "signoff", input: "x" });
    assert.equal(paused.status, "waiting");
    assert.equal(paused.waiting?.reason, "awaiting_human");

    const cancelled = await surface.cancel(paused.runId, "not doing it");
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(() => surface.resume(paused.runId), /run_cancelled/);
    // Cancelling twice is not an error; cancelling something already finished is.
    assert.equal((await surface.cancel(paused.runId)).status, "cancelled");
    await assert.rejects(() => surface.pause(paused.runId), /run_not_pausable:cancelled/);

    const done = await surface.run({ id: "signoff", input: "y", runId: "run-done" });
    assert.equal(done.status, "waiting");
    await surface.resume("run-done");
    await assert.rejects(() => surface.cancel("run-done"), /run_not_cancellable:completed/);
  });

  it("refuses to resume as a principal the operator has since paused", async () => {
    const store = createMemoryFlowStore();
    const { runtime, surface } = harness(store);
    const agent = runtime.defaultAgent;
    const gated = flow("signoff", "Sign-off")
      .wait("hold", { detail: "a human signs off" })
      .model("done", { prompt: "done" })
      .build();
    await surface.save(gated);
    const paused = await surface.run({ id: "signoff", as: agent });
    assert.equal(paused.status, "waiting");

    await runtime.pauseAgent(agent, "suspected key leak");
    await assert.rejects(() => surface.resume(paused.runId), /run_principal_paused/);
  });

  it("leaves paused runs alone on boot instead of running the step they stopped before", async () => {
    const store = createMemoryFlowStore();
    const { surface } = harness(store);
    const gated = flow("signoff", "Sign-off")
      .wait("hold", { detail: "a human signs off" })
      .model("done", { prompt: "done" })
      .build();
    await surface.save(gated);
    await surface.run({ id: "signoff" });

    const second = harness(store);
    await second.surface.save(gated);
    assert.deepEqual(await second.surface.hydrateRuns(), { resumed: 0, failed: 0, paused: 1 });
    assert.equal((await second.surface.openRuns()).length, 1);
  });
});

describe("flow run lifecycle routes", () => {
  function buildApp() {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const model = new MemoryModelProvider();
    const flows = createFlowsSurface({ runtime, model, store: createMemoryFlowStore() });
    const app = createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows,
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    });
    return { app, flows, runtime };
  }

  const post = (app: ReturnType<typeof buildApp>["app"], path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("pauses, resumes and cancels a run over HTTP", async () => {
    const { app, flows } = buildApp();
    await flows.save(
      flow("signoff", "Sign-off")
        .wait("hold", { detail: "a human signs off" })
        .model("done", { prompt: "done" })
        .build(),
    );
    const run = await flows.run({ id: "signoff" });

    const state = await app.request(`/flows/runs/state?runId=${run.runId}`);
    assert.equal(state.status, 200);
    const body = (await state.json()) as { state: { status: string }; checkpoints: unknown[] };
    assert.equal(body.state.status, "waiting");
    assert.equal(body.checkpoints.length, 1);

    const resumed = await post(app, "/flows/runs/resume", { runId: run.runId });
    assert.equal(resumed.status, 200);
    assert.equal(((await resumed.json()) as { status: string }).status, "completed");
  });

  it("answers 409 when a cancelled run is asked to resume, and 404 for a stranger", async () => {
    const { app, flows } = buildApp();
    await flows.save(
      flow("signoff", "Sign-off")
        .wait("hold", { detail: "a human signs off" })
        .model("done", { prompt: "done" })
        .build(),
    );
    const run = await flows.run({ id: "signoff" });

    const cancelled = await post(app, "/flows/runs/cancel", { runId: run.runId });
    assert.equal(cancelled.status, 200);

    const resumed = await post(app, "/flows/runs/resume", { runId: run.runId });
    assert.equal(resumed.status, 409);
    assert.equal(((await resumed.json()) as { error: string }).error, "run_cancelled");

    const missing = await post(app, "/flows/runs/resume", { runId: "run-nope" });
    assert.equal(missing.status, 404);

    const noId = await post(app, "/flows/runs/pause", {});
    assert.equal(noId.status, 400);
  });

  it("cancels an agent's parked runs when the agent itself is paused", async () => {
    const { app, flows, runtime } = buildApp();
    await flows.save(
      flow("signoff", "Sign-off")
        .wait("hold", { detail: "a human signs off" })
        .model("done", { prompt: "done" })
        .build(),
    );
    const run = await flows.run({ id: "signoff", as: runtime.defaultAgent });
    assert.equal(run.status, "waiting");

    const paused = await post(app, "/agents/pause", {
      agent: runtime.defaultAgent,
      reason: "suspected key leak",
    });
    assert.equal(paused.status, 200);
    const body = (await paused.json()) as { cancelledRuns: string[] };
    assert.deepEqual(body.cancelledRuns, [run.runId], "the parked run does not outlive the pause");
    assert.equal((await flows.runState(run.runId))?.status, "cancelled");
  });

  it("lists open runs so a stalled one is visible after it scrolls off the ring", async () => {
    const { app, flows } = buildApp();
    await flows.save(
      flow("signoff", "Sign-off")
        .wait("hold", { detail: "a human signs off" })
        .model("done", { prompt: "done" })
        .build(),
    );
    await flows.run({ id: "signoff" });

    const res = await app.request("/flows/runs/open");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runs: Array<{ status: string; pause?: { reason: string } }> };
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0]?.status, "waiting");
    assert.equal(body.runs[0]?.pause?.reason, "awaiting_human");
  });
});

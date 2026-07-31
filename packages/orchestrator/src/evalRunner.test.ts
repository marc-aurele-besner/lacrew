/**
 * Running the eval suite from a workspace (F2.29, cloud half).
 *
 * The behaviour worth pinning is not "it returns results" — it is the two
 * things that keep a test run from hurting a live crew: the suite runs in a
 * *child* process (so its network block cannot reach this one's calls), and one
 * run at a time with a deadline.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createOrchestratorApp } from "./httpApp.js";
import { createEvalRunner, evalTimeoutMs, resolveEvalRunner } from "./evalRunner.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { CrewRuntime } from "./runtime.js";
import { createLacrewClient } from "@lacrew/sdk/testing";

/** The real child entry point, which the suite ships with `@lacrew/flows`. */
const RUNNER = resolveEvalRunner();

test("the suite runs in a child process against the real scenarios", async () => {
  const runner = createEvalRunner();
  const scenarios = await runner.list();

  assert.ok(scenarios.length > 0, "the first-party suite should ship scenarios");
  const first = scenarios[0]!;
  assert.ok(first.id);

  const result = await runner.run({ ids: [first.id] });
  assert.equal(result.matched, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.id, first.id);
  // The seed suite is green; a red one here would mean the harness broke, and
  // that is worth failing this test over.
  assert.equal(result.ok, true, JSON.stringify(result.results[0]!.failures));
});

test("this process's fetch is untouched while a suite runs", async () => {
  const runner = createEvalRunner();
  const before = globalThis.fetch;
  const scenarios = await runner.list();
  await runner.run({ ids: [scenarios[0]!.id] });
  // The whole reason for the subprocess: a run that blocked fetch here would
  // fail every connector call and RPC read in flight.
  assert.equal(globalThis.fetch, before);
});

test("a filter that matches nothing reports zero rather than a green suite", async () => {
  const runner = createEvalRunner();
  const result = await runner.run({ flow: "no-such-flow" });
  assert.equal(result.matched, 0);
  assert.equal(result.results.length, 0);
  assert.equal(result.passed, 0);
});

test("a second run while one is in flight is refused, not queued", async () => {
  const runner = createEvalRunner();
  const scenarios = await runner.list();
  const first = runner.run({ ids: [scenarios[0]!.id] });
  await assert.rejects(runner.run({ ids: [scenarios[0]!.id] }), /eval_already_running/);
  await first;
  // And the lock is released, so the next caller is served.
  assert.equal(runner.busy(), false);
  await runner.run({ ids: [scenarios[0]!.id] });
});

test("a child that hangs is killed at the deadline", async () => {
  const runner = createEvalRunner({
    timeoutMs: 5_000,
    scriptPath: RUNNER,
    // A node that ignores the script and sleeps: the runner must not wait on it.
    nodePath: process.execPath,
    spawnImpl: ((_cmd: string, _args: string[], options: unknown) =>
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], options as never)) as never,
  });
  await assert.rejects(runner.run({}), /eval_timeout/);
});

test("a child that prints nothing carries its stderr rather than a blank failure", async () => {
  const runner = createEvalRunner({
    scriptPath: RUNNER,
    spawnImpl: ((_cmd: string, _args: string[], options: unknown) =>
      spawn(
        process.execPath,
        ["-e", "console.error('boom: the suite could not load'); process.exit(3)"],
        options as never,
      )) as never,
  });
  await assert.rejects(runner.run({}), /eval_no_output \(exit 3\).*boom/s);
});

test("the deadline is bounded below and configurable", () => {
  assert.equal(evalTimeoutMs({}), 120_000);
  assert.equal(evalTimeoutMs({ LACREW_EVAL_TIMEOUT_MS: "30000" }), 30_000);
  // A deadline shorter than a suite can possibly take is one that only ever
  // reports a timeout.
  assert.equal(evalTimeoutMs({ LACREW_EVAL_TIMEOUT_MS: "10" }), 120_000);
});

function buildApp() {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const model = new MemoryModelProvider();
  return {
    runtime,
    app: createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows: createFlowsSurface({ runtime, model, store: createMemoryFlowStore() }),
      evals: createEvalRunner(),
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    }),
  };
}

test("GET /flows/eval lists scenarios, filterable by blueprint", async () => {
  const { app } = buildApp();
  const all = (await (await app.request("/flows/eval")).json()) as {
    scenarios: Array<{ id: string; blueprint?: string }>;
  };
  assert.ok(all.scenarios.length > 0);

  const blueprint = all.scenarios.find((s) => s.blueprint)?.blueprint;
  const filtered = (await (
    await app.request(`/flows/eval?blueprint=${encodeURIComponent(blueprint!)}`)
  ).json()) as { scenarios: Array<{ blueprint?: string }> };
  assert.ok(filtered.scenarios.length > 0);
  assert.ok(filtered.scenarios.every((s) => s.blueprint === blueprint));
});

test("POST /flows/eval runs a scenario and audits that it was asked", async () => {
  const { app, runtime } = buildApp();
  const scenarios = (await (await app.request("/flows/eval")).json()) as {
    scenarios: Array<{ id: string }>;
  };
  const res = await app.request("/flows/eval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [scenarios.scenarios[0]!.id] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; matched: number; passed: number };
  assert.equal(body.matched, 1);
  assert.equal(body.ok, true);

  const row = (await runtime.audit()).find((e) => e.type === "FlowEvalRun");
  assert.ok(row, "a run should leave a trail row");
  assert.equal(row.payload.matched, 1);
  assert.equal(row.payload.passed, 1);
});

test("POST /flows/eval answers 503 when no runner is wired", async () => {
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
  const res = await app.request("/flows/eval", { method: "POST" });
  assert.equal(res.status, 503);
});

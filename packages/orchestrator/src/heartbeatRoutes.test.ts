import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createHeartbeatSurface } from "./heartbeat.js";
import { createMemoryHeartbeatStore } from "./heartbeatStore.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp } from "./httpApp.js";

async function buildApp() {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const model = new MemoryModelProvider();
  const flows = createFlowsSurface({ runtime, model, store: createMemoryFlowStore() });
  await flows.save(flow("desk-digest", "Desk digest").model("write", { prompt: "go" }).build());

  const heartbeats = createHeartbeatSurface({
    runtime,
    flows,
    store: createMemoryHeartbeatStore(),
  });
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows,
    heartbeats,
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, heartbeats, runtime };
}

/** Typed read of a JSON response; the routes are what is under test. */
async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Listing = {
  heartbeats: Array<{ crewId: string; enabled: boolean }>;
  presets: Array<{ label: string; schedule: string }>;
  minIntervalMinutes: number;
  maxItems: number;
  store: string;
};

const post = (app: Awaited<ReturnType<typeof buildApp>>["app"], path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const good = {
  crewId: "trading",
  schedule: "*/30 * * * *",
  checklist: [{ kind: "flow", id: "desk-digest" }],
  enabled: true,
};

describe("heartbeat routes", () => {
  it("saves a heartbeat and lists it with the cadence vocabulary a UI needs", async () => {
    const { app } = await buildApp();
    const saved = await post(app, "/heartbeats", { heartbeat: good });
    assert.equal(saved.status, 200);

    const listed = await jsonOf<Listing>(await app.request("/heartbeats"));
    assert.equal(listed.heartbeats.length, 1);
    assert.equal(listed.heartbeats[0]!.crewId, "trading");
    assert.ok(listed.presets.length > 0);
    assert.ok(listed.minIntervalMinutes > 0);
    assert.equal(listed.store, "memory");
  });

  it("answers 400 for a checklist naming a flow this orchestrator does not have", async () => {
    const { app } = await buildApp();
    const res = await post(app, "/heartbeats", {
      heartbeat: { ...good, checklist: [{ kind: "flow", id: "ghost" }] },
    });
    assert.equal(res.status, 400);
    assert.match((await jsonOf<{ error: string }>(res)).error, /heartbeat_unknown_flow/);
  });

  it("answers 400 for a cadence under the floor and for an enabled empty checklist", async () => {
    const { app } = await buildApp();
    const dense = await post(app, "/heartbeats", {
      heartbeat: { ...good, schedule: "* * * * *" },
    });
    assert.equal(dense.status, 400);
    const empty = await post(app, "/heartbeats", { heartbeat: { ...good, checklist: [] } });
    assert.equal(empty.status, 400);
  });

  it("answers 404 for enabling a crew that has no heartbeat", async () => {
    const { app } = await buildApp();
    const res = await post(app, "/heartbeats/enabled", { crewId: "nobody", enabled: true });
    assert.equal(res.status, 404);
  });

  it("runs the checklist on request and reports the tick", async () => {
    const { app, runtime } = await buildApp();
    await post(app, "/heartbeats", { heartbeat: good });
    const res = await post(app, "/heartbeats/run", { crewId: "trading" });
    assert.equal(res.status, 200);
    const { tick } = await jsonOf<{ tick: { status: string; items: unknown[] } }>(res);
    assert.equal(tick.status, "ok");
    assert.equal(tick.items.length, 1);
    assert.equal(runtime.thread({ kind: "crew", id: "trading" }).length, 1);

    const ticks = await jsonOf<{ ticks: unknown[] }>(
      await app.request("/heartbeats/ticks?crewId=trading"),
    );
    assert.equal(ticks.ticks.length, 1);
  });

  it("removes a heartbeat and stops answering for it", async () => {
    const { app } = await buildApp();
    await post(app, "/heartbeats", { heartbeat: good });
    const removed = await post(app, "/heartbeats/delete", { crewId: "trading" });
    assert.deepEqual(await jsonOf<{ removed: boolean }>(removed), { removed: true });
    const listed = await jsonOf<Listing>(await app.request("/heartbeats"));
    assert.equal(listed.heartbeats.length, 0);
  });

  it("reports heartbeat state on /health so an operator can see it is on", async () => {
    const { app } = await buildApp();
    await post(app, "/heartbeats", { heartbeat: good });
    const health = await jsonOf<{ heartbeats: { configured: number; enabled: number } }>(
      await app.request("/health"),
    );
    assert.equal(health.heartbeats.configured, 1);
    assert.equal(health.heartbeats.enabled, 1);
  });

  it("answers 503 rather than 404 when the embedder wired no heartbeat surface", async () => {
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
    const res = await app.request("/heartbeats");
    assert.equal(res.status, 503);
    assert.equal((await jsonOf<{ error: string }>(res)).error, "heartbeats_unavailable");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp } from "./httpApp.js";

function buildApp(authToken?: string) {
  const runtime = new CrewRuntime();
  const model = new MemoryModelProvider();
  const flows = createFlowsSurface({ runtime, model });
  return createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows,
    mcpUseMock: true,
    authToken,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
}

describe("orchestrator Hono app", () => {
  it("serves /health with the full status shape", async () => {
    const res = await buildApp().request("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.service, "lacrew-orchestrator");
    assert.equal(body.mode, "mock");
    assert.equal((body.auth as { required: boolean }).required, false);
    assert.equal(body.runtimeStore, "memory");
  });

  it("reports a listing as unlisted in mock mode rather than inventing a price", async () => {
    const res = await buildApp().request("/marketplace/quote?catalogId=flow-x");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.listed, false);
    assert.equal(body.gross, "0");
    assert.equal(body.purchased, false);
  });

  it("requires catalogId on quote", async () => {
    const res = await buildApp().request("/marketplace/quote");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "catalogId_required" });
  });

  it("requires payee on earnings", async () => {
    const res = await buildApp().request("/marketplace/earnings");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "payee_required" });
  });

  it("refuses to settle a purchase without a chain instead of faking a receipt", async () => {
    const res = await buildApp().request("/marketplace/purchase", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "flow-x", agent: "0x0000000000000000000000000000000000000001" }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "marketplace_purchase_requires_chain" });
  });

  it("validates purchase input", async () => {
    const res = await buildApp().request("/marketplace/purchase", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "0x0000000000000000000000000000000000000001" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "catalogId_required" });
  });

  it("refuses to register a listing without a chain", async () => {
    const res = await buildApp().request("/marketplace/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "flow-x", price: "1000000" }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "marketplace_requires_chain" });
  });

  it("validates register input", async () => {
    const res = await buildApp().request("/marketplace/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "flow-x" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "price_required" });
  });

  it("404s unknown routes as JSON", async () => {
    const res = await buildApp().request("/nope");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  it("keeps /health open but guards everything else when a token is set", async () => {
    const app = buildApp("secret-token");
    assert.equal((await app.request("/health")).status, 200);

    const denied = await app.request("/intents");
    assert.equal(denied.status, 401);

    const allowed = await app.request("/intents", {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(allowed.status, 200);
  });

  it("runs the mock tick → escalate path over HTTP", async () => {
    const app = buildApp();
    const res = await app.request("/tick", { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; intentId: string };
    assert.equal(body.verdict, "ESCALATE");

    const resolve = await app.request("/intents/resolve", {
      method: "POST",
      body: JSON.stringify({ intentId: body.intentId, approved: true }),
    });
    assert.equal(resolve.status, 200);

    const history = await app.request("/intents/history");
    const historyBody = (await history.json()) as {
      intents: Array<{ status: string }>;
      store: string;
    };
    assert.equal(historyBody.store, "memory");
    assert.equal(historyBody.intents[0]?.status, "approved");
  });

  it("validates flow run input and 404s unknown flows", async () => {
    const app = buildApp();
    const missing = await app.request("/flows/run", { method: "POST", body: "{}" });
    assert.equal(missing.status, 400);

    const unknown = await app.request("/flows/run", {
      method: "POST",
      body: JSON.stringify({ id: "flow-does-not-exist" }),
    });
    assert.equal(unknown.status, 404);
  });

  it("streams mock epochs and lists governance over HTTP", async () => {
    const app = buildApp();
    const res = await app.request("/epoch", { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { epoch: number; flowRuns: unknown[] };
    assert.equal(body.epoch, 1);
    assert.deepEqual(body.flowRuns, []);

    const hire = await app.request("/governance/propose-hire", {
      method: "POST",
      body: JSON.stringify({ label: "Scout" }),
    });
    assert.equal(hire.status, 200);
    const proposals = await app.request("/governance/proposals");
    const proposalsBody = (await proposals.json()) as { proposals: unknown[] };
    assert.equal(proposalsBody.proposals.length, 1);
  });
});

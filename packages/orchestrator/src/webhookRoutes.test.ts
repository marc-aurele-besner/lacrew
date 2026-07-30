import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp } from "./httpApp.js";
import { createWebhookSurface, type WebhookJob } from "./webhooks.js";
import { createMemoryWebhookStore } from "./webhookStore.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signLacrewDelivery } from "./webhookSignature.js";

const BODY = JSON.stringify({ action: "opened", pull_request: { number: 7 } });

async function buildApp(authToken?: string) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const model = new MemoryModelProvider();
  const flows = createFlowsSurface({ runtime, model, store: createMemoryFlowStore() });
  const def = flow("pr-triage", "PR triage").model("sum", { prompt: "{{input}}" }).build();
  await flows.save({ ...def, trigger: "webhook" });

  const queue = new InMemoryQueue();
  const jobs: WebhookJob[] = [];
  const webhooks = createWebhookSurface({
    runtime,
    flows,
    store: createMemoryWebhookStore(),
    enqueue: async (job) => {
      jobs.push(job);
      await queue.enqueue("webhook", job as unknown as Record<string, unknown>);
    },
  });
  await queue.start({ onWebhook: async (data) => webhooks.deliver(data as unknown as WebhookJob) });

  const app = createOrchestratorApp({
    runtime,
    queue,
    model,
    flows,
    webhooks,
    mcpUseMock: true,
    ...(authToken ? { authToken } : {}),
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, queue, flows, jobs, webhooks };
}

function signedHeaders(secret: string, body: string, extra: Record<string, string> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(secret, ts, body),
    [TIMESTAMP_HEADER]: String(ts),
    ...extra,
  };
}

async function createTrigger(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  body: Record<string, unknown> = { flowId: "pr-triage" },
  authToken?: string,
): Promise<{ id: string; secret: string }> {
  const res = await app.request("/flows/triggers", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
  });
  assert.equal(res.status, 201);
  const json = (await res.json()) as { trigger: { id: string }; secret: string };
  return { id: json.trigger.id, secret: json.secret };
}

describe("webhook routes", () => {
  it("mints a trigger and reports it on /health and /flows/triggers", async () => {
    const { app } = await buildApp();
    const { id, secret } = await createTrigger(app);
    assert.ok(secret.length > 0);

    const list = (await (await app.request("/flows/triggers")).json()) as {
      triggers: Array<Record<string, unknown>>;
    };
    assert.equal(list.triggers.length, 1);
    assert.equal(list.triggers[0]?.id, id);
    assert.ok(!JSON.stringify(list).includes(secret), "the secret is served exactly once");

    const health = (await (await app.request("/health")).json()) as {
      webhooks: { triggers: number; enabled: number };
    };
    assert.equal(health.webhooks.triggers, 1);
    assert.equal(health.webhooks.enabled, 1);
  });

  it("rejects a trigger for a flow that does not declare the webhook trigger", async () => {
    const { app, flows } = await buildApp();
    const manual = flow("manual-only", "Manual").model("s", { prompt: "x" }).build();
    await flows.save(manual);

    const res = await app.request("/flows/triggers", {
      method: "POST",
      body: JSON.stringify({ flowId: "manual-only" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "flow_not_webhook_triggered");

    const missing = await app.request("/flows/triggers", {
      method: "POST",
      body: JSON.stringify({ flowId: "no-such-flow" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(missing.status, 404);
  });

  it("accepts a signed delivery with 202 and runs it off the HTTP thread", async () => {
    const { app, queue, flows, jobs } = await buildApp();
    const { id, secret } = await createTrigger(app);

    const res = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: signedHeaders(secret, BODY),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { accepted: boolean; runId: string };
    assert.equal(body.accepted, true);
    assert.match(body.runId, /^run-wh-/);
    assert.equal(jobs.length, 1);

    await queue.drain();
    const runs = flows.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.runId, body.runId);
    assert.equal(runs[0]?.trigger, "webhook");
  });

  it("401s an unsigned or forged delivery and starts nothing", async () => {
    const { app, queue, flows } = await buildApp();
    const { id, secret } = await createTrigger(app);

    const bare = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: { "content-type": "application/json" },
    });
    assert.equal(bare.status, 401);
    assert.equal(((await bare.json()) as { error: string }).error, "webhook_signature_missing");

    const forged = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: signedHeaders("not-the-secret", BODY),
    });
    assert.equal(forged.status, 401);

    // Signed for a different body than the one sent.
    const tampered = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "closed" }),
      headers: signedHeaders(secret, BODY),
    });
    assert.equal(tampered.status, 401);

    await queue.drain();
    assert.equal(flows.runs().length, 0);
  });

  it("404s an unknown trigger id", async () => {
    const { app } = await buildApp();
    const res = await app.request("/hooks/wht_does_not_exist", {
      method: "POST",
      body: BODY,
      headers: signedHeaders("any", BODY),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "webhook_trigger_not_found");
  });

  it("413s a body over the cap without buffering it", async () => {
    const { app } = await buildApp();
    const { id, secret } = await createTrigger(app);
    const huge = JSON.stringify({ blob: "x".repeat(2_000_000) });
    const res = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: huge,
      headers: {
        ...signedHeaders(secret, huge),
        "content-length": String(Buffer.byteLength(huge)),
      },
    });
    assert.equal(res.status, 413);
  });

  it("answers a redelivery 200 duplicate instead of running twice", async () => {
    const { app, queue, flows } = await buildApp();
    const { id, secret } = await createTrigger(app);
    const headers = signedHeaders(secret, BODY, { "idempotency-key": "abc-123" });

    const first = await app.request(`/hooks/${id}`, { method: "POST", body: BODY, headers });
    const second = await app.request(`/hooks/${id}`, { method: "POST", body: BODY, headers });
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { duplicate: boolean }).duplicate, true);

    await queue.drain();
    assert.equal(flows.runs().length, 1);
  });

  it("rotates through the route: old signature dead, new one live", async () => {
    const { app } = await buildApp();
    const { id, secret } = await createTrigger(app);

    const rotated = await app.request("/flows/triggers/rotate", {
      method: "POST",
      body: JSON.stringify({ id }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(rotated.status, 200);
    const next = ((await rotated.json()) as { secret: string }).secret;
    assert.notEqual(next, secret);

    const stale = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: signedHeaders(secret, BODY),
    });
    assert.equal(stale.status, 401);

    const fresh = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: signedHeaders(next, BODY),
    });
    assert.equal(fresh.status, 202);
  });

  it("disables and re-enables a trigger, and lists its deliveries", async () => {
    const { app } = await buildApp();
    const { id, secret } = await createTrigger(app);

    const off = await app.request("/flows/triggers/enabled", {
      method: "POST",
      body: JSON.stringify({ id, enabled: false }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(off.status, 200);

    const blocked = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: signedHeaders(secret, BODY),
    });
    assert.equal(blocked.status, 403);

    await app.request("/flows/triggers/enabled", {
      method: "POST",
      body: JSON.stringify({ id, enabled: true }),
      headers: { "content-type": "application/json" },
    });
    const ok = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: signedHeaders(secret, BODY),
    });
    assert.equal(ok.status, 202);

    const log = (await (await app.request("/flows/triggers/deliveries")).json()) as {
      deliveries: Array<{ result: string; reason?: string | null }>;
    };
    assert.ok(log.deliveries.some((d) => d.reason === "webhook_trigger_disabled"));
    assert.ok(log.deliveries.some((d) => d.result !== "rejected"));
    // The log explains what happened without ever echoing the body or secret.
    assert.ok(!JSON.stringify(log).includes(secret));
    assert.ok(!JSON.stringify(log).includes("pull_request"));
  });

  it("keeps management behind the bearer token while hooks stay HMAC-authenticated", async () => {
    const token = "orch-token";
    const { app } = await buildApp(token);

    const unauthorized = await app.request("/flows/triggers");
    assert.equal(unauthorized.status, 401);

    const { id, secret } = await createTrigger(app, { flowId: "pr-triage" }, token);

    // No bearer token — the HMAC is the credential this route accepts.
    const delivered = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: signedHeaders(secret, BODY),
    });
    assert.equal(delivered.status, 202);

    // ...and the carve-out does not make the route open: an unsigned delivery
    // is still refused, so no bearer token is not the same as no auth.
    const bare = await app.request(`/hooks/${id}`, {
      method: "POST",
      body: BODY,
      headers: { "content-type": "application/json" },
    });
    assert.equal(bare.status, 401);
  });

  it("503s the surface when no webhook wiring is present", async () => {
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
    const res = await app.request("/hooks/wht_anything", { method: "POST", body: "{}" });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, "webhooks_unavailable");
  });
});

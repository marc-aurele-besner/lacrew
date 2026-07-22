import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp } from "./httpApp.js";
import { createLacrewClient } from "@lacrew/sdk/testing";

function buildApp(authToken?: string) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
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
    // The field a caller checks to decide whether the data can be trusted, so
    // it has to follow the runtime rather than assert a healthy answer.
    assert.equal(body.mocked, true);
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

  it("serves the electorate with weights, roles, and the real quorums", async () => {
    const app = buildApp();
    const res = await app.request("/governance/electorate");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      seats: Array<{ voter: string; power: string; role: string }>;
      config: { quorumYes: string; quorumHumanYes: string; humanRoot: string };
      mode: string;
    };

    assert.ok(body.seats.length > 0, "expected at least one seat");
    // Weight and seat class are what execute() gates on, so both must be served.
    for (const seat of body.seats) {
      assert.ok(seat.voter.startsWith("0x"), `bad voter ${seat.voter}`);
      assert.match(seat.power, /^\d+$/, `power must be an integer string, got ${seat.power}`);
      assert.ok(["human", "agent", "none"].includes(seat.role), `bad role ${seat.role}`);
    }

    // Only human weight can satisfy a high-tier proposal.
    assert.ok(
      body.seats.some((s) => s.role === "human"),
      "the fixture electorate must include a human seat",
    );

    assert.match(body.config.quorumYes, /^\d+$/);
    assert.match(body.config.quorumHumanYes, /^\d+$/);
    assert.ok(body.config.humanRoot.startsWith("0x"));
    assert.equal(body.mode, "mock");
  });

  it("never serves a zero-power seat as part of the electorate", async () => {
    const app = buildApp();
    const res = await app.request("/governance/electorate");
    const body = (await res.json()) as { seats: Array<{ power: string }> };
    // A zero-power address cannot vote at all — vote() reverts NoVotingPower.
    assert.equal(
      body.seats.filter((s) => s.power === "0").length,
      0,
      "a zero-power seat is not part of the electorate",
    );
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
  /* ——— Session scopes ——— */

  async function boot(app: ReturnType<typeof buildApp>, body: unknown) {
    const res = await app.request("/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as Record<string, any> };
  }

  it("grants the full vocabulary when the caller does not narrow it", async () => {
    const { res, body } = await boot(buildApp(), {});
    assert.equal(res.status, 200);
    assert.deepEqual(body.session.scopes.slice().sort(), [
      "propose:intent",
      "spend:whitelist",
    ]);
  });

  it("issues a narrowed session when scopes are requested", async () => {
    const { res, body } = await boot(buildApp(), { scopes: ["propose:intent"] });
    assert.equal(res.status, 200);
    assert.deepEqual(body.session.scopes, ["propose:intent"]);
  });

  /**
   * The cache is keyed on agent+limits, so without a scope comparison a narrow
   * request would be served the wide session booted before it.
   */
  it("does not hand a cached wide session to a narrow request", async () => {
    const app = buildApp();
    const wide = await boot(app, {});
    assert.equal(wide.body.session.scopes.length, 2);
    const narrow = await boot(app, { scopes: ["propose:intent"] });
    assert.deepEqual(narrow.body.session.scopes, ["propose:intent"]);
  });

  it("reuses the session when the same scopes are asked for again", async () => {
    const app = buildApp();
    const first = await boot(app, { scopes: ["propose:intent"] });
    const second = await boot(app, { scopes: ["propose:intent"] });
    assert.equal(first.body.session.keyId, second.body.session.keyId);
  });

  /**
   * propose/purchase boot without scopes. If that reset the agent to the full
   * set, a narrowing would last exactly one call and never be observable.
   */
  it("keeps a narrowing in force for later internal boots", async () => {
    const app = buildApp();
    await boot(app, { scopes: ["propose:intent"] });
    const implicit = await boot(app, {});
    assert.deepEqual(implicit.body.session.scopes, ["propose:intent"]);
  });

  it("re-widens only when asked to explicitly", async () => {
    const app = buildApp();
    await boot(app, { scopes: ["propose:intent"] });
    const widened = await boot(app, { scopes: ["propose:intent", "spend:whitelist"] });
    assert.equal(widened.body.session.scopes.length, 2);
    const implicit = await boot(app, {});
    assert.equal(implicit.body.session.scopes.length, 2);
  });

  it("rejects an unknown scope instead of dropping it", async () => {
    const { res, body } = await boot(buildApp(), { scopes: ["spend:everything"] });
    assert.equal(res.status, 400);
    assert.match(body.error, /^unknown_scopes: spend:everything$/);
    assert.deepEqual(body.known, ["propose:intent", "spend:whitelist"]);
  });

  it("rejects an empty scope list — the registry would refuse the mask anyway", async () => {
    const { res, body } = await boot(buildApp(), { scopes: [] });
    assert.equal(res.status, 400);
    assert.equal(body.error, "scopes_must_be_a_non_empty_array");
  });
});

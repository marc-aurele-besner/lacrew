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

  it("answers batch entitlement with every buyer unentitled in mock mode", async () => {
    const res = await buildApp().request(
      "/marketplace/entitlement?catalogId=flow-x&buyers=0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002",
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.catalogId, "flow-x");
    assert.equal(body.purchased, false);
    assert.deepEqual(body.entitlements, {
      "0x0000000000000000000000000000000000000001": false,
      "0x0000000000000000000000000000000000000002": false,
    });
  });

  it("requires buyers on batch entitlement", async () => {
    const res = await buildApp().request("/marketplace/entitlement?catalogId=flow-x");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "buyers_required" });
  });

  it("rejects non-address buyers on batch entitlement", async () => {
    const res = await buildApp().request(
      "/marketplace/entitlement?catalogId=flow-x&buyers=not-an-address",
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "buyers_must_be_addresses" });
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

  it("refuses to withdraw without a chain instead of faking a payout", async () => {
    const res = await buildApp().request("/marketplace/withdraw", { method: "POST" });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "marketplace_requires_chain" });
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

  it("serves per-asset treasury balances (empty in mock mode, not invented)", async () => {
    const res = await buildApp().request("/treasury/balances");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { balances: unknown[]; mode: string };
    // The offline runtime holds no real treasury, so it reports no holdings
    // rather than a fabricated book.
    assert.deepEqual(body.balances, []);
  });

  it("serves the asset-stack list (empty in mock mode, not invented)", async () => {
    const res = await buildApp().request("/assets");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { assets: unknown[]; mode: string };
    // The offline runtime has no address book to read stacks from, so it
    // reports none rather than a fabricated picker list.
    assert.deepEqual(body.assets, []);
    assert.equal(body.mode, "mock");
  });

  it("refuses to deploy a node stack without a chain instead of faking proposals", async () => {
    const res = await buildApp().request("/governance/propose-node-stack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        node: "0x000000000000000000000000000000000000dEaD",
        modules: [
          { kind: "whitelist" },
          { kind: "rate_limit", maxActions: 5, windowSeconds: 86400 },
        ],
      }),
    });
    // A deploy cannot be mocked honestly: 409, never an invented stack address.
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "policy_deploy_requires_chain" });
  });

  it("validates node-stack input before touching the chain", async () => {
    const app = buildApp();
    const post = (payload: unknown) =>
      app.request("/governance/propose-node-stack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    const noNode = await post({ modules: [{ kind: "whitelist" }] });
    assert.equal(noNode.status, 400);
    assert.deepEqual(await noNode.json(), { error: "node_required" });

    const node = "0x000000000000000000000000000000000000dEaD";
    const empty = await post({ node, modules: [] });
    assert.deepEqual(await empty.json(), { error: "modules_required" });

    const badRate = await post({
      node,
      modules: [{ kind: "rate_limit", maxActions: 0, windowSeconds: 3600 }],
    });
    assert.deepEqual(await badRate.json(), { error: "invalid_rate_limit_params" });

    // Mirrors TimeWindowPolicy's constructor guard: end must exceed start.
    const badWindow = await post({
      node,
      modules: [{ kind: "time_window", startSecondOfDay: 3600, endSecondOfDay: 3600 }],
    });
    assert.deepEqual(await badWindow.json(), { error: "invalid_time_window_params" });

    const badKind = await post({ node, modules: [{ kind: "teleport" }] });
    assert.deepEqual(await badKind.json(), { error: "unknown_module_kind" });
  });

  it("serves usage counts from real operations, flagged incomplete off the ring", async () => {
    const app = buildApp();
    // Two real operations: a tick that escalates (IntentCreated + SessionIssued)
    // and its approval (IntentResolved).
    const tick = await app.request("/tick", { method: "POST", body: "{}" });
    const { intentId } = (await tick.json()) as { intentId: string };
    await app.request("/intents/resolve", {
      method: "POST",
      body: JSON.stringify({ intentId, approved: true }),
    });

    const res = await app.request("/usage");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      complete: boolean;
      store: string;
      since: string;
    };
    assert.equal(body.counts.IntentCreated, 1);
    assert.equal(body.counts.IntentResolved, 1);
    assert.ok((body.counts.SessionIssued ?? 0) >= 1);
    // No database behind this app: the ring answered, and it must say so —
    // a bounded count served as a period total is a billing lie.
    assert.equal(body.complete, false);
    assert.equal(body.store, "memory");
    assert.ok(!Number.isNaN(Date.parse(body.since)));
  });

  it("rejects an unparseable ?since= on /usage", async () => {
    const res = await buildApp().request("/usage?since=last-tuesday");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_since" });
  });

  it("counts nothing before ?since=", async () => {
    const app = buildApp();
    await app.request("/tick", { method: "POST", body: "{}" });
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await app.request(`/usage?since=${encodeURIComponent(future)}`);
    const body = (await res.json()) as { counts: Record<string, number> };
    assert.deepEqual(body.counts, {});
  });

  it("serves node policies (empty in mock mode, not invented)", async () => {
    const res = await buildApp().request("/policies");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { policies: unknown[]; mode: string };
    // The offline runtime has no policy contracts to read; an invented stack
    // would be a claim about what an agent is allowed to spend.
    assert.deepEqual(body.policies, []);
    assert.equal(body.mode, "mock");
  });

  it("rejects a malformed ?node= on /policies as operator input", async () => {
    const res = await buildApp().request("/policies?node=not-an-address");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error?: string }).error, "invalid_node");
  });

  it("rejects an asset-selected policy read in mock mode", async () => {
    const res = await buildApp().request("/policies?asset=WETH");
    // The mock (single-asset) runtime cannot resolve a WETH stack: with an
    // asset supplied that is the caller's input, a 400 — not a 500.
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error?: string }).error ?? "", /asset/i);
  });

  it("rejects an asset-selected whitelist change in mock mode", async () => {
    const res = await buildApp().request("/governance/propose-set-whitelist", {
      method: "POST",
      body: JSON.stringify({
        target: "0x000000000000000000000000000000000000dEaD",
        allowed: true,
        asset: "WETH",
      }),
    });
    // Whitelists are per-stack; the mock cannot resolve one, and the selector
    // is the caller's input — 400, not 500.
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error?: string }).error ?? "", /asset/i);
  });

  it("rejects an asset-selected agent cap as operator input in mock mode", async () => {
    const res = await buildApp().request("/governance/propose-set-agent-cap", {
      method: "POST",
      body: JSON.stringify({
        agent: "0x000000000000000000000000000000000000dEaD",
        cap: "1000000000000000000",
        asset: "WETH",
      }),
    });
    // The mock (single-asset) runtime cannot resolve a WETH stack: with an
    // asset supplied that is the caller's input, a 400 — not a 500.
    assert.equal(res.status, 400);
  });

  it("threads an asset selector through grant/epoch and rejects non-primary in mock mode", async () => {
    const app = buildApp();
    const worker = "0x000000000000000000000000000000000000dEaD";

    // No asset → the primary (USDC) stack, unchanged: a proposal is created.
    const primaryGrant = await app.request("/governance/propose-set-grant", {
      method: "POST",
      body: JSON.stringify({ account: worker, amount: "1000000" }),
    });
    assert.equal(primaryGrant.status, 200);

    // A non-primary asset cannot resolve a stack in the mock (single-asset)
    // client — the operator's bad input is a 400, not the primary path's 500.
    const wethGrant = await app.request("/governance/propose-set-grant", {
      method: "POST",
      body: JSON.stringify({ account: worker, amount: "1000000000000000000", asset: "WETH" }),
    });
    assert.equal(wethGrant.status, 400);
    assert.match(((await wethGrant.json()) as { error?: string }).error ?? "", /asset/i);

    // Same for a per-asset epoch: the mock throw surfaces as epochError, and
    // with no epoch flows to run the endpoint reports it as 400.
    const wethEpoch = await app.request("/epoch", {
      method: "POST",
      body: JSON.stringify({ asset: "WETH" }),
    });
    assert.equal(wethEpoch.status, 400);
    assert.match(((await wethEpoch.json()) as { epochError?: string }).epochError ?? "", /asset/i);
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

  it("accepts a valid daily window and rate limit", async () => {
    const { res } = await boot(buildApp(), {
      window: { start: 9 * 3600, end: 17 * 3600 },
      rate: { maxProposals: 5, ratePeriod: 3600 },
    });
    assert.equal(res.status, 200);
  });

  it("rejects a window whose end is not after its start", async () => {
    const { res, body } = await boot(buildApp(), { window: { start: 17 * 3600, end: 9 * 3600 } });
    assert.equal(res.status, 400);
    assert.match(body.error, /^invalid_window/);
  });

  it("rejects a rate limit with a non-positive cap", async () => {
    const { res, body } = await boot(buildApp(), { rate: { maxProposals: 0, ratePeriod: 3600 } });
    assert.equal(res.status, 400);
    assert.match(body.error, /^invalid_rate/);
  });
});

describe("POST /governance/propose-set-grants", () => {
  const entry = (account: string, amount: string) => ({ account, amount });

  it("creates one proposal for a batch of grants", async () => {
    const res = await buildApp().request("/governance/propose-set-grants", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          entry("0x2222222222222222222222222222222222222222", "10000000"),
          entry("0x3333333333333333333333333333333333333333", "20000000"),
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposalId: string; count: number };
    assert.ok(body.proposalId);
    assert.equal(body.count, 2);
  });

  it("rejects an empty batch", async () => {
    const res = await buildApp().request("/governance/propose-set-grants", {
      method: "POST",
      body: JSON.stringify({ entries: [] }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "entries_required");
  });

  it("rejects an entry missing its amount", async () => {
    const res = await buildApp().request("/governance/propose-set-grants", {
      method: "POST",
      body: JSON.stringify({ entries: [{ account: "0x2222222222222222222222222222222222222222" }] }),
    });
    assert.equal(res.status, 400);
  });
});

describe("GET /governance/grants", () => {
  it("returns configured per-epoch grants as base-unit strings", async () => {
    const res = await buildApp().request("/governance/grants");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      grants: Array<{ account: string; amount: string }>;
    };
    assert.ok(Array.isArray(body.grants));
    // Mock org seeds at least one funded node; amounts are exact strings.
    assert.ok(body.grants.length >= 1);
    for (const g of body.grants) {
      assert.match(g.account, /^0x[a-fA-F0-9]{40}$/);
      assert.match(g.amount, /^\d+$/);
    }
  });
});

describe("POST /epoch/schedule", () => {
  it("reschedules the epoch to a valid cron", async () => {
    const res = await buildApp().request("/epoch/schedule", {
      method: "POST",
      body: JSON.stringify({ cron: "0 0 * * 0" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { schedule: string | null; queue: string };
    assert.equal(body.schedule, "0 0 * * 0");
    assert.equal(body.queue, "memory");
  });

  it("normalizes whitespace in the cron before scheduling", async () => {
    const res = await buildApp().request("/epoch/schedule", {
      method: "POST",
      body: JSON.stringify({ cron: "  0   0   *  * 0 " }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { schedule: string }).schedule, "0 0 * * 0");
  });

  it("rejects a malformed cron", async () => {
    const res = await buildApp().request("/epoch/schedule", {
      method: "POST",
      body: JSON.stringify({ cron: "not a cron" }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_cron");
  });

  it("rejects a cron with the wrong field count", async () => {
    const res = await buildApp().request("/epoch/schedule", {
      method: "POST",
      body: JSON.stringify({ cron: "0 0 * *" }),
    });
    assert.equal(res.status, 400);
  });
});

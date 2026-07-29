import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp } from "./httpApp.js";
import {
  buildConnectorPreset,
  createConnectorRegistry,
  type ConnectorRegistry,
} from "./index.js";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { BRIEF_MAX_CHARS } from "./agentControls.js";

function buildApp(authToken?: string, connectors?: ConnectorRegistry) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const model = new MemoryModelProvider();
  const flows = createFlowsSurface({ runtime, model });
  return createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows,
    connectors,
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

  it("serves an empty /connectors with the presets still offered", async () => {
    const res = await buildApp().request("/connectors");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      connectors: unknown[];
      available: Array<{ id: string; auth: Array<{ mode: string }> }>;
    };
    // No connector registered is the normal state, not an error — but the
    // catalog must still say what could be added, and keep the two apart.
    assert.deepEqual(body.connectors, []);
    assert.ok(body.available.some((p) => p.id === "github"));
    assert.deepEqual(
      body.available.find((p) => p.id === "github")!.auth.map((a) => a.mode),
      ["github-app", "token"],
    );
  });

  it("says which presets need a host and which need no credential at all", async () => {
    const res = await buildApp().request("/connectors");
    const body = (await res.json()) as {
      available: Array<{
        id: string;
        baseUrl: string | null;
        baseUrlRequired?: boolean;
        baseUrlNote?: string;
        headers?: Record<string, string>;
        auth: Array<{ mode: string }>;
      }>;
    };

    // Ghost runs on the operator's own domain. Omitting the field would read as
    // "no base URL needed" to a catalog built on this response, when in fact
    // the preset will not build without one.
    const ghost = body.available.find((p) => p.id === "ghost")!;
    assert.equal(ghost.baseUrl, null);
    assert.equal(ghost.baseUrlRequired, true);
    assert.match(ghost.baseUrlNote!, /ghost\/api\/admin/);

    const npm = body.available.find((p) => p.id === "npm")!;
    assert.deepEqual(
      npm.auth.map((a) => a.mode),
      ["none"],
    );
    assert.equal(npm.baseUrlRequired, undefined);

    // A version pin is part of the connector, so a catalog must be able to see
    // it without registering one.
    assert.equal(body.available.find((p) => p.id === "notion")!.headers?.["Notion-Version"], "2022-06-28");
  });

  it("reports a registered connector's wiring without any credential in it", async () => {
    const registry = createConnectorRegistry({
      connectors: [
        buildConnectorPreset("github", {
          authMode: "token",
          policyTargets: { merge_pull_request: "0x00000000000000000000000000000000000000aa" },
        }),
      ],
      env: { GH_TOKEN: "ghp_supersecret" },
    });
    const res = await buildApp(undefined, registry).request("/connectors");
    const body = (await res.json()) as {
      connectors: Array<{
        id: string;
        auth: { kind: string; envVars: string[]; ready: boolean };
        routes: Array<{ name: string; effect: string; policyTarget: string | null }>;
      }>;
      available: Array<{ id: string }>;
    };

    assert.equal(body.connectors.length, 1);
    assert.equal(body.connectors[0]!.id, "github");
    assert.equal(body.connectors[0]!.auth.kind, "bearer");
    assert.deepEqual(body.connectors[0]!.auth.envVars, ["GH_TOKEN"]);
    assert.equal(body.connectors[0]!.auth.ready, true);

    const merge = body.connectors[0]!.routes.find((r) => r.name === "merge_pull_request")!;
    assert.equal(merge.effect, "write");
    assert.equal(merge.policyTarget, "0x00000000000000000000000000000000000000aa");

    // Registered is not "available to add" — a catalog that conflates them
    // tells an operator a crew can merge when nothing is wired.
    assert.ok(!body.available.some((p) => p.id === "github"));
    assert.ok(!JSON.stringify(body).includes("ghp_supersecret"));
  });

  it("reports a connector whose credential is absent as not ready", async () => {
    const registry = createConnectorRegistry({
      connectors: [
        buildConnectorPreset("github", { authMode: "token", omitRoutes: ["merge_pull_request"] }),
      ],
      env: {},
    });
    const res = await buildApp(undefined, registry).request("/connectors");
    const body = (await res.json()) as { connectors: Array<{ auth: { ready: boolean } }> };
    assert.equal(body.connectors[0]!.auth.ready, false);
  });

  it("keeps /connectors behind the bearer token when one is set", async () => {
    const res = await buildApp("s3cr3t").request("/connectors");
    assert.equal(res.status, 401);
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

  it("serves agent wallets grouped by chain (no chain entry in mock mode)", async () => {
    const res = await buildApp().request("/agents/balances");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { chains: unknown[]; mode: string };
    // No chain answered, which is not the same claim as "the accounts are
    // empty" — that would be a chain entry whose wallets all read zero.
    assert.deepEqual(body.chains, []);
    assert.equal(body.mode, "mock");
  });

  it("serves an empty watchlist, and accepts one that validates", async () => {
    const app = buildApp();
    const empty = (await (await app.request("/wallets/watchlist")).json()) as {
      watchlist: unknown[];
    };
    assert.deepEqual(empty.watchlist, []);

    const res = await app.request("/wallets/watchlist", {
      method: "POST",
      body: JSON.stringify({
        watchlist: [
          {
            chainId: 8453,
            rpcUrl: "https://base-mainnet.example/v2/SECRET",
            tokens: [
              {
                symbol: "USDC",
                address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                decimals: 6,
              },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);

    const saved = (await (await app.request("/wallets/watchlist")).json()) as {
      watchlist: Array<{ chainId: number; rpcUrl?: string }>;
    };
    assert.equal(saved.watchlist[0]?.chainId, 8453);
    // The endpoint is echoed so an operator can recognise it; the key inside
    // it is not, because this response can land in a log.
    assert.equal(saved.watchlist[0]?.rpcUrl, "https://base-mainnet.example/v2/…");
  });

  it("refuses a malformed watchlist rather than storing half of it", async () => {
    const res = await buildApp().request("/wallets/watchlist", {
      method: "POST",
      body: JSON.stringify({ watchlist: [{ chainId: 1, tokens: [{ symbol: "X", address: "0xnope", decimals: 6 }] }] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /20-byte hex address/);
  });

  it("refuses a token lookup it cannot answer, rather than guessing", async () => {
    const app = buildApp();
    // Operator input errors are 400 and never leave the machine.
    assert.equal((await app.request("/wallets/token?chainId=0&address=0x1")).status, 400);
    assert.equal(
      (await app.request("/wallets/token?chainId=8453&address=nope")).status,
      400,
    );
    // A chain with no endpoint and no public default cannot be asked. That is
    // 503 "could not ask", never 404 "this is not a token" — telling an
    // operator their correct address is wrong sends them to fix nothing.
    const res = await app.request(
      "/wallets/token?chainId=999999&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, "unreachable");
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
  /* ——— standing agent controls (F1.7) ——— */

  it("reports no paused agents and no briefs on a fresh runtime", async () => {
    const res = await buildApp().request("/agents/controls");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { paused: unknown[]; briefs: unknown[] };
    assert.deepEqual(body.paused, []);
    assert.deepEqual(body.briefs, []);
  });

  it("pausing an agent refuses it a session key until it is resumed", async () => {
    const app = buildApp();
    const agent = "0x0000000000000000000000000000000000000a11";

    const paused = await app.request("/agents/pause", {
      method: "POST",
      body: JSON.stringify({ agent, reason: "spending anomaly" }),
    });
    assert.equal(paused.status, 200);
    assert.equal(((await paused.json()) as { paused: boolean }).paused, true);

    // The gate is the point: booting must fail rather than hand back a key.
    const booted = await app.request("/boot", {
      method: "POST",
      body: JSON.stringify({ agent }),
    });
    assert.equal(booted.status, 500);
    assert.match(((await booted.json()) as { error: string }).error, /agent_paused/);

    const resumed = await app.request("/agents/resume", {
      method: "POST",
      body: JSON.stringify({ agent }),
    });
    assert.equal(((await resumed.json()) as { changed: boolean }).changed, true);
  });

  it("names the paused agent and why, so the trail carries the decision", async () => {
    const app = buildApp();
    const agent = "0x0000000000000000000000000000000000000a12";
    await app.request("/agents/pause", {
      method: "POST",
      body: JSON.stringify({ agent, reason: "spending anomaly" }),
    });
    const body = (await (await app.request("/agents/controls")).json()) as {
      paused: Array<{ agent: string; reason?: string }>;
    };
    assert.equal(body.paused.length, 1);
    assert.equal(body.paused[0]?.agent, agent.toLowerCase());
    assert.equal(body.paused[0]?.reason, "spending anomaly");
  });

  it("requires an agent on both control routes", async () => {
    const app = buildApp();
    for (const path of ["/agents/pause", "/agents/resume"]) {
      const res = await app.request(path, { method: "POST", body: JSON.stringify({}) });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: string }).error, "agent_required");
    }
  });

  it("a brief becomes the system prompt, with the identity line still leading", async () => {
    const app = buildApp();
    const agent = "0x0000000000000000000000000000000000000a13";
    const res = await app.request("/agents/brief", {
      method: "PUT",
      body: JSON.stringify({
        agent,
        layers: [
          { label: "crew:Trading", text: "Quote before you fill." },
          { label: "agent", text: "You settle; you do not price." },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { systemPrompt: string };
    assert.ok(body.systemPrompt.startsWith(`You are agent ${agent} in a LaCrew organization.`));
    assert.match(body.systemPrompt, /Quote before you fill\./);
    assert.match(body.systemPrompt, /You settle; you do not price\./);
  });

  it("clearing a brief returns the agent to the bare identity line", async () => {
    const app = buildApp();
    const agent = "0x0000000000000000000000000000000000000a14";
    await app.request("/agents/brief", {
      method: "PUT",
      body: JSON.stringify({ agent, layers: [{ label: "agent", text: "Settle only." }] }),
    });
    const cleared = await app.request("/agents/brief", {
      method: "PUT",
      body: JSON.stringify({ agent, layers: [] }),
    });
    const body = (await cleared.json()) as { brief: unknown; systemPrompt: string };
    assert.equal(body.brief, null);
    assert.equal(body.systemPrompt, `You are agent ${agent} in a LaCrew organization.`);
  });

  it("refuses a brief past the ceiling rather than storing a document", async () => {
    const res = await buildApp().request("/agents/brief", {
      method: "PUT",
      body: JSON.stringify({
        agent: "0x0000000000000000000000000000000000000a15",
        // Derived from the constant, never a literal: the ceiling moved once
        // already (a structured directive renders larger than it types) and a
        // hardcoded figure silently stopped testing the limit.
        layers: [{ label: "agent", text: "x".repeat(BRIEF_MAX_CHARS + 1) }],
      }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /brief_too_long/);
  });

  it("requires a layer list, so a missing field never silently clears a brief", async () => {
    const res = await buildApp().request("/agents/brief", {
      method: "PUT",
      body: JSON.stringify({ agent: "0x0000000000000000000000000000000000000a16" }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "layers_required");
  });
  it("serves the org-wide question queue on the feed", async () => {
    const app = buildApp();
    await app.request("/messages", {
      method: "POST",
      body: JSON.stringify({
        thread: "crew:trading",
        author: "0x0000000000000000000000000000000000000a20",
        authorKind: "agent",
        kind: "question",
        body: "merge?",
      }),
    });
    // Without this, a question is only findable by opening the thread that
    // holds it — and one nobody opens looks exactly like one nobody asked.
    const body = (await (await app.request("/messages")).json()) as {
      openQuestions: Array<{ body: string }>;
    };
    assert.equal(body.openQuestions.length, 1);
    assert.equal(body.openQuestions[0]?.body, "merge?");
  });
});

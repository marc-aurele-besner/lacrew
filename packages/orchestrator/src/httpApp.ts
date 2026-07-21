/**
 * Orchestrator HTTP surface as a Hono app (node:http bootstrap in server.ts).
 * Mocked by default; onchain when ANVIL_RPC + PRIVATE_KEY are set.
 * Auth: bearer token on every route except GET /health when a token is set.
 */

import { Hono, type Context } from "hono";
import { listLacrewMcpTools, runMcpTool } from "@lacrew/adapter-agents-mcp";
import type { FlowDefinition } from "@lacrew/flows";
import { isSessionScope, SESSION_SCOPES, type SessionScope } from "@lacrew/core";
import { isAuthorized } from "./auth.js";
import type { CrewRuntime } from "./runtime.js";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import type { createFlowsSurface } from "./flows.js";
import type { QueueProvider } from "./queue/index.js";
import type { ModelProvider } from "./model/index.js";

export interface OrchestratorAppOptions {
  runtime: CrewRuntime;
  queue: QueueProvider;
  model: ModelProvider;
  flows: ReturnType<typeof createFlowsSurface>;
  mcpBackend?: McpToolBackend;
  mcpUseMock: boolean;
  authToken?: string;
  /** Live DB reachability (checked once on boot). */
  isDbReady: () => boolean;
  isDbConfigured: () => boolean;
}

/** JSON response with bigint-safe serialization (matches SDK return shapes). */
function jsonBig(c: Context, body: unknown, status = 200): Response {
  return c.newResponse(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    status as 200,
    {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  );
}

async function bodyOf<T>(c: Context): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T;
}

export function createOrchestratorApp(options: OrchestratorAppOptions): Hono {
  const { runtime, queue, model, flows, mcpBackend, mcpUseMock, authToken } = options;
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.newResponse(null, 204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
      });
    }
    // Health stays open so pools/load balancers can probe without the token.
    if (authToken && !(c.req.method === "GET" && c.req.path === "/health")) {
      if (!isAuthorized(c.req.header("authorization"), authToken)) {
        return jsonBig(c, { error: "unauthorized" }, 401);
      }
    }
    await next();
  });

  app.onError((err, c) => jsonBig(c, { error: err.message || "unknown" }, 500));
  app.notFound((c) => jsonBig(c, { error: "not_found" }, 404));

  app.get("/health", async (c) =>
    jsonBig(c, {
      ok: true,
      service: "lacrew-orchestrator",
      mocked: runtime.mode === "mock",
      mode: runtime.mode,
      chainId: runtime.chainId,
      db: { configured: options.isDbConfigured(), ready: options.isDbReady() },
      queue: queue.status(),
      model: { provider: model.name },
      mcp: { tools: listLacrewMcpTools().length, useMock: mcpUseMock },
      flows: {
        saved: (await flows.list()).length,
        templates: flows.templates().length,
        store: flows.storeName,
      },
      auth: { required: Boolean(authToken) },
      audit: { persisted: options.isDbReady() },
      runtimeStore: runtime.runtimeStoreName,
    }),
  );

  app.post("/model/complete", async (c) => {
    const body = await bodyOf<{ system?: string; prompt?: string; model?: string }>(c);
    if (!body.prompt?.trim()) return jsonBig(c, { error: "prompt_required" }, 400);
    const result = await model.complete({
      system: body.system,
      prompt: body.prompt,
      model: body.model,
    });
    return jsonBig(c, { ...result, provider: model.name });
  });

  app.get("/mcp/tools", (c) =>
    jsonBig(c, { tools: listLacrewMcpTools(), useMock: mcpUseMock, mode: runtime.mode }),
  );

  app.post("/mcp/call", async (c) => {
    const body = await bodyOf<{ name?: string; arguments?: Record<string, unknown> }>(c);
    if (!body.name?.trim()) return jsonBig(c, { error: "name_required" }, 400);
    const result = await runMcpTool(body.name, body.arguments ?? {}, {
      backend: mcpBackend,
      useMock: mcpUseMock,
    });
    return jsonBig(c, { name: body.name, result, useMock: mcpUseMock, mode: runtime.mode });
  });

  // ?as=<address> filters to the flows that agent is scoped to see.
  app.get("/flows", async (c) => {
    const as = c.req.query("as") as `0x${string}` | undefined;
    return jsonBig(c, { flows: await flows.list(as), mode: runtime.mode });
  });

  app.post("/flows", async (c) => {
    const body = await bodyOf<{ flow?: FlowDefinition }>(c);
    if (!body.flow?.id) return jsonBig(c, { error: "flow_required" }, 400);
    try {
      return jsonBig(c, { flow: await flows.save(body.flow), mode: runtime.mode });
    } catch (err) {
      return jsonBig(c, { error: err instanceof Error ? err.message : "invalid_flow" }, 400);
    }
  });

  app.post("/flows/delete", async (c) => {
    const body = await bodyOf<{ id?: string }>(c);
    if (!body.id) return jsonBig(c, { error: "id_required" }, 400);
    return jsonBig(c, { removed: await flows.remove(body.id) });
  });

  app.post("/flows/run", async (c) => {
    const body = await bodyOf<{
      id?: string;
      flow?: FlowDefinition;
      input?: string;
      as?: `0x${string}`;
    }>(c);
    if (!body.id && !body.flow) return jsonBig(c, { error: "id_or_flow_required" }, 400);
    try {
      return jsonBig(c, await flows.run(body));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "flow_run_failed";
      const status = msg === "flow_not_found" ? 404 : msg === "flow_out_of_scope" ? 403 : 400;
      return jsonBig(c, { error: msg }, status);
    }
  });

  app.get("/flows/runs", (c) => jsonBig(c, { runs: flows.runs(), mode: runtime.mode }));

  app.get("/flows/templates", (c) => jsonBig(c, { templates: flows.templates() }));

  /**
   * Boot (or rotate) a session key. Scopes narrow what the key may do; omitting
   * them grants the full vocabulary, which is what an unmodified caller expects.
   * An unknown scope is a 400 rather than a silent drop — issuing a key with
   * less authority than asked for fails later and far from the typo.
   */
  app.post("/boot", async (c) => {
    const body = await bodyOf<{
      agent?: string;
      scopes?: string[];
      maxValue?: string;
      allowedTarget?: string;
    }>(c);

    let scopes: SessionScope[] | undefined;
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
        return jsonBig(c, { error: "scopes_must_be_a_non_empty_array" }, 400);
      }
      const unknown = body.scopes.filter((s) => !isSessionScope(s));
      if (unknown.length > 0) {
        return jsonBig(
          c,
          { error: `unknown_scopes: ${unknown.join(", ")}`, known: SESSION_SCOPES },
          400,
        );
      }
      scopes = body.scopes as SessionScope[];
    }

    const session = await runtime.boot(body.agent as `0x${string}` | undefined, {
      scopes,
      maxValue: body.maxValue ? BigInt(body.maxValue) : undefined,
      allowedTarget: body.allowedTarget as `0x${string}` | undefined,
    });
    return jsonBig(c, { session });
  });

  app.get("/sessions", async (c) =>
    jsonBig(c, {
      sessions: await runtime.listSessions(),
      mode: runtime.mode,
      chainId: runtime.chainId,
    }),
  );

  app.get("/sessions/history", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return jsonBig(c, {
      sessions: await runtime.sessionHistory(limit),
      store: runtime.runtimeStoreName,
      mode: runtime.mode,
    });
  });

  app.post("/sessions/revoke", async (c) => {
    const body = await bodyOf<{ sessionId?: string }>(c);
    if (!body.sessionId) return jsonBig(c, { error: "sessionId_required" }, 400);
    const result = await runtime.revokeSessionById(body.sessionId);
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.post("/tick", async (c) => {
    const body = await bodyOf<{ value?: string }>(c);
    const value = body.value ? BigInt(body.value) : 75n * 10n ** 6n;
    return jsonBig(c, await runtime.tick(value));
  });

  app.get("/intents", async (c) => jsonBig(c, { intents: await runtime.listPending() }));

  app.get("/intents/history", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return jsonBig(c, {
      intents: await runtime.intentHistory(limit),
      store: runtime.runtimeStoreName,
      mode: runtime.mode,
    });
  });

  app.get("/audit", async (c) => jsonBig(c, { events: await runtime.audit() }));

  app.get("/org", async (c) =>
    jsonBig(c, {
      nodes: await runtime.getClient().getOrgTree(),
      mode: runtime.mode,
      chainId: runtime.chainId,
    }),
  );

  app.post("/intents/resolve", async (c) => {
    const body = await bodyOf<{
      intentId?: string;
      approved?: boolean;
      approver?: `0x${string}`;
    }>(c);
    if (!body.intentId || typeof body.approved !== "boolean") {
      return jsonBig(c, { error: "intentId_and_approved_required" }, 400);
    }
    return jsonBig(c, await runtime.resolve(body.intentId, body.approved, body.approver));
  });

  app.get("/marketplace/quote", async (c) => {
    const catalogId = c.req.query("catalogId");
    if (!catalogId) return jsonBig(c, { error: "catalogId_required" }, 400);
    const buyer = c.req.query("buyer") as `0x${string}` | undefined;
    const quote = await runtime.marketplaceQuote(catalogId);
    const entitlement = buyer
      ? await runtime.marketplaceEntitlement(catalogId, buyer)
      : { purchased: false };
    return jsonBig(c, { ...quote, ...entitlement, mode: runtime.mode, chainId: runtime.chainId });
  });

  app.get("/marketplace/earnings", async (c) => {
    const payee = c.req.query("payee") as `0x${string}` | undefined;
    if (!payee) return jsonBig(c, { error: "payee_required" }, 400);
    return jsonBig(c, { ...(await runtime.marketplaceEarnings(payee)), mode: runtime.mode });
  });

  app.post("/marketplace/list", async (c) => {
    const body = await bodyOf<{ catalogId?: string; price?: string }>(c);
    if (!body.catalogId?.trim()) return jsonBig(c, { error: "catalogId_required" }, 400);
    if (body.price === undefined) return jsonBig(c, { error: "price_required" }, 400);
    try {
      const result = await runtime.marketplaceRegister({
        catalogId: body.catalogId.trim(),
        price: String(body.price),
      });
      return jsonBig(c, { ...result, mode: runtime.mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : "register_failed";
      return jsonBig(c, { error: message }, message === "marketplace_requires_chain" ? 409 : 400);
    }
  });

  app.post("/marketplace/purchase", async (c) => {
    const body = await bodyOf<{
      catalogId?: string;
      agent?: `0x${string}`;
      buyer?: `0x${string}`;
    }>(c);
    if (!body.catalogId?.trim()) return jsonBig(c, { error: "catalogId_required" }, 400);
    if (!body.agent) return jsonBig(c, { error: "agent_required" }, 400);
    try {
      const result = await runtime.marketplacePurchase({
        catalogId: body.catalogId.trim(),
        agent: body.agent,
        buyer: body.buyer,
      });
      return jsonBig(c, { ...result, mode: runtime.mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : "purchase_failed";
      // A chainless runtime cannot settle, and saying so beats a fake receipt.
      return jsonBig(c, { error: message }, message === "marketplace_purchase_requires_chain" ? 409 : 400);
    }
  });

  app.get("/governance/proposals", async (c) =>
    jsonBig(c, {
      proposals: await runtime.listProposals(),
      mode: runtime.mode,
      chainId: runtime.chainId,
    }),
  );

  /**
   * The electorate and the quorum thresholds `execute()` gates on.
   *
   * Weight is enforced onchain, so this is a read of `votingPower` / `seatRole`
   * and the two quorums — not a policy this process decides. A consumer showing
   * a quorum should use these numbers: the contract's deployed defaults are
   * mutable by the human root.
   */
  app.get("/governance/electorate", async (c) => {
    try {
      const { seats, config, mode } = await runtime.listElectorate();
      return jsonBig(c, { seats, config, mode, chainId: runtime.chainId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "electorate_failed";
      // A client that cannot read seats says so rather than inventing an
      // electorate — a fabricated seat list is worse than an absent one.
      return jsonBig(c, { error: message }, 501);
    }
  });

  app.post("/governance/propose-hire", async (c) => {
    const body = await bodyOf<{
      label?: string;
      kind?: "manager_agent" | "worker_agent";
      parent?: `0x${string}`;
      tier?: "low" | "high";
    }>(c);
    if (!body.label?.trim()) return jsonBig(c, { error: "label_required" }, 400);
    const result = await runtime.proposeHire({
      label: body.label.trim(),
      kind: body.kind,
      parent: body.parent,
      tier: body.tier,
    });
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.post("/governance/propose-fire", async (c) => {
    const body = await bodyOf<{ account?: `0x${string}`; tier?: "low" | "high" }>(c);
    if (!body.account) return jsonBig(c, { error: "account_required" }, 400);
    const result = await runtime.proposeFire({ account: body.account, tier: body.tier });
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.post("/governance/propose-reparent", async (c) => {
    const body = await bodyOf<{
      account?: `0x${string}`;
      newParent?: `0x${string}`;
      tier?: "low" | "high";
    }>(c);
    if (!body.account || !body.newParent) {
      return jsonBig(c, { error: "account_and_newParent_required" }, 400);
    }
    const result = await runtime.proposeReparent({
      account: body.account,
      newParent: body.newParent,
      tier: body.tier,
    });
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.post("/governance/propose-set-grant", async (c) => {
    const body = await bodyOf<{
      account?: `0x${string}`;
      amount?: string | number;
      tier?: "low" | "high";
    }>(c);
    if (!body.account || body.amount === undefined || body.amount === "") {
      return jsonBig(c, { error: "account_and_amount_required" }, 400);
    }
    const amount = BigInt(body.amount);
    const result = await runtime.proposeSetGrant({
      account: body.account,
      amount,
      tier: body.tier,
    });
    return jsonBig(c, { ...result, mode: runtime.mode, amount: amount.toString() });
  });

  app.post("/governance/propose-set-node-policy", async (c) => {
    const body = await bodyOf<{
      node?: `0x${string}`;
      policyModule?: `0x${string}`;
      tier?: "low" | "high";
    }>(c);
    if (!body.node || !body.policyModule) {
      return jsonBig(c, { error: "node_and_policyModule_required" }, 400);
    }
    const result = await runtime.proposeSetNodePolicy({
      node: body.node,
      policyModule: body.policyModule,
      tier: body.tier,
    });
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.post("/governance/propose-set-whitelist", async (c) => {
    const body = await bodyOf<{
      target?: `0x${string}`;
      allowed?: boolean;
      tier?: "low" | "high";
    }>(c);
    if (!body.target || typeof body.allowed !== "boolean") {
      return jsonBig(c, { error: "target_and_allowed_required" }, 400);
    }
    const result = await runtime.proposeSetWhitelist({
      target: body.target,
      allowed: body.allowed,
      tier: body.tier,
    });
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.post("/governance/propose-set-agent-cap", async (c) => {
    const body = await bodyOf<{
      agent?: `0x${string}`;
      cap?: string | number;
      tier?: "low" | "high";
    }>(c);
    if (!body.agent || body.cap === undefined || body.cap === "") {
      return jsonBig(c, { error: "agent_and_cap_required" }, 400);
    }
    const cap = BigInt(body.cap);
    const result = await runtime.proposeSetAgentCap({
      agent: body.agent,
      cap,
      tier: body.tier,
    });
    return jsonBig(c, { ...result, mode: runtime.mode, cap: cap.toString() });
  });

  app.post("/governance/vote", async (c) => {
    const body = await bodyOf<{ proposalId?: string; support?: boolean }>(c);
    if (!body.proposalId || typeof body.support !== "boolean") {
      return jsonBig(c, { error: "proposalId_and_support_required" }, 400);
    }
    const result = await runtime.voteGovernance(body.proposalId, body.support);
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.post("/governance/veto", async (c) => {
    const body = await bodyOf<{ proposalId?: string }>(c);
    if (!body.proposalId) return jsonBig(c, { error: "proposalId_required" }, 400);
    const result = await runtime.vetoGovernance(body.proposalId);
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.post("/governance/execute", async (c) => {
    const body = await bodyOf<{ proposalId?: string }>(c);
    if (!body.proposalId) return jsonBig(c, { error: "proposalId_required" }, 400);
    const result = await runtime.executeGovernance(body.proposalId);
    return jsonBig(c, { ...result, mode: runtime.mode });
  });

  app.get("/epoch", (c) => {
    const q = queue.status();
    return runtime.getCurrentEpoch().then((currentEpoch) =>
      jsonBig(c, {
        currentEpoch,
        mode: runtime.mode,
        chainId: runtime.chainId,
        schedule: q.epochSchedule ?? null,
        queue: q.provider,
      }),
    );
  });

  app.post("/epoch", async (c) => {
    // Epoch-triggered flows fire even when the onchain stream can't run
    // (mock mode) — the automation layer stays testable everywhere.
    let result: Record<string, unknown> = {};
    let epochError: string | undefined;
    try {
      result = (await runtime.runEpoch()) as unknown as Record<string, unknown>;
    } catch (err) {
      epochError = err instanceof Error ? err.message : "epoch_failed";
    }
    const epochRuns = await flows.runTriggered("epoch");
    return jsonBig(
      c,
      {
        ...result,
        ...(epochError ? { epochError } : {}),
        mode: runtime.mode,
        flowRuns: epochRuns.map((r) => ({
          runId: r.runId,
          flowId: r.flowId,
          status: r.status,
          steps: r.steps.length,
        })),
      },
      epochError && epochRuns.length === 0 ? 400 : 200,
    );
  });

  return app;
}

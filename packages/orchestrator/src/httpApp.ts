/**
 * Orchestrator HTTP surface as a Hono app (node:http bootstrap in server.ts).
 * Mocked by default; onchain when ANVIL_RPC + PRIVATE_KEY are set.
 * Auth: bearer token on every route except GET /health when a token is set.
 */

import { Hono, type Context } from "hono";
import { listLacrewMcpTools, runMcpTool } from "@lacrew/adapter-agents-mcp";
import type { FlowDefinition } from "@lacrew/flows";
import { firstPartySkillPacks, getSkillPack, missingRequirements, type SkillPack } from "@lacrew/flows";
import {
  HEARTBEAT_MAX_ITEMS,
  HEARTBEAT_MIN_INTERVAL_MINUTES,
  HEARTBEAT_PRESETS,
  type CrewHeartbeat,
} from "@lacrew/flows";
import type { HeartbeatSurface } from "./heartbeat.js";
import {
  INFERENCE_BUDGET_WARN_RATIO,
  isInferenceBudgetExceeded,
  type InferenceBudget,
} from "@lacrew/flows";
import type { InferenceBudgetsSurface } from "./inferenceBudgets.js";
import {
  createSkillPacksSurface,
  readSkillPack,
  SkillPackRequirementsError,
  SkillPackTooLargeError,
} from "./skillPacks.js";
import { isSessionScope, SESSION_SCOPES, type OrgNode, type SessionScope } from "@lacrew/core";
import { ancestorsOf } from "./flowScope.js";
import { scopeOfThread } from "./conversation.js";
import { isAuthorized } from "./auth.js";
import { autoExecuteEnabled } from "./governanceSweep.js";
import { connectorPresets } from "./connectorPresets.js";
import { maskRpcUrl, parseWatchlist } from "./walletWatchlist.js";
import type { ConnectorRegistry } from "./connectors.js";
import type { ConnectorAsksSurface } from "./connectorAsks.js";
import type { EvalRunnerSurface } from "./evalRunner.js";
import {
  validateExternalMcpRule,
  type ExternalMcpRegistry,
  type ExternalMcpToolRule,
} from "./externalMcp.js";
import type { HumanGatesSurface } from "./humanGates.js";
import {
  CONNECTOR_WRITE_MODES,
  isConnectorWriteMode,
  parseModeScope,
  validateModeRoute,
  type ConnectorModesSurface,
} from "./connectorPolicy.js";
import type { CrewRuntime, NodeStackModuleSpec } from "./runtime.js";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import type { createFlowsSurface } from "./flows.js";
import { webhookMaxBodyBytes, type WebhookInputMap, type WebhookSurface } from "./webhooks.js";
import { describeEventSources } from "./eventSources.js";
import type { EventSourceId } from "./eventSources.js";
import type { QueueProvider } from "./queue/index.js";
import type { ModelProvider } from "./model/index.js";

export interface OrchestratorAppOptions {
  runtime: CrewRuntime;
  queue: QueueProvider;
  model: ModelProvider;
  flows: ReturnType<typeof createFlowsSurface>;
  mcpBackend?: McpToolBackend;
  /** Absent when no connector is registered — the normal state, not an error. */
  connectors?: ConnectorRegistry;
  /** Write-mode rules (F2.24); absent in embedders that wired none. */
  connectorModes?: ConnectorModesSurface;
  /** Attached third-party MCP servers (F2.30); absent when none is configured. */
  externalMcp?: ExternalMcpRegistry;
  /** Eval suite runner (F2.29); absent in embedders that wired none. */
  evals?: EvalRunnerSurface;
  /** Pending and resolved ask-mode confirmations (F2.24). */
  connectorAsks?: ConnectorAsksSurface;
  /** Open and resolved blocking human gates (F2.27). */
  humanGates?: HumanGatesSurface;
  /** Absent when the embedder wired no queue-backed webhook surface. */
  webhooks?: WebhookSurface;
  /** Crew heartbeats (F2.21); absent in embedders that wired none. */
  heartbeats?: HeartbeatSurface;
  /** Inference & API cost budgets (F2.28); absent in embedders that wired none. */
  budgets?: InferenceBudgetsSurface;
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

function msgOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Map a trigger-management failure onto the status its cause deserves. */
function triggerErrorStatus(err: unknown): number {
  const msg = msgOf(err, "");
  if (msg === "flow_not_found" || msg === "webhook_trigger_not_found") return 404;
  // Sealing is a deployment gap, not a bad request: the operator's payload was
  // fine and the fix is an env var, so a 4xx would point them at the wrong file.
  if (msg === "webhook_sealing_unavailable" || msg === "webhook_secret_unreadable") return 503;
  return 400;
}

/** Map a heartbeat failure onto the status its cause deserves. */
function heartbeatErrorStatus(err: unknown): number {
  const msg = msgOf(err, "");
  if (msg === "heartbeat_not_found") return 404;
  // A tick already in flight is not a bad request and not a server fault: the
  // caller's config is fine and the same call succeeds once it finishes.
  if (msg === "heartbeat_already_running") return 409;
  return 400;
}

/** One standard cron field: `*`, numbers, ranges, lists, and steps. */
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

/** Cheap 5-field cron pre-check; the durable queue is the semantic backstop. */
function isValidCron(expr: string): boolean {
  const fields = expr.split(" ").filter(Boolean);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

export function createOrchestratorApp(options: OrchestratorAppOptions): Hono {
  const {
    runtime,
    queue,
    model,
    flows,
    mcpBackend,
    connectors,
    connectorModes,
    externalMcp,
    evals,
    connectorAsks,
    humanGates,
    webhooks,
    heartbeats,
    budgets,
    mcpUseMock,
    authToken,
  } = options;
  const app = new Hono();

  /**
   * The seat's reporting line, nearest first — what a crew-scoped write rule
   * resolves through. An unreadable chart yields none, which falls back to the
   * workspace rule or the route's own default rather than to a guess.
   */
  const managersOf = async (agent: string): Promise<string[]> => {
    try {
      const nodes = (await runtime.getClient().getOrgTree()) as OrgNode[];
      return [...ancestorsOf(nodes, agent)];
    } catch {
      return [];
    }
  };

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.newResponse(null, 204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
      });
    }
    // Health stays open so pools/load balancers can probe without the token.
    // Hook deliveries too: a webhook producer is an external system that has
    // the trigger's HMAC secret and no reason to hold the operator's bearer
    // token. `POST /hooks/:id` authenticates every request against that
    // signature and rejects an unsigned one — it is not an unauthenticated
    // route, it is one authenticated by a different, narrower credential.
    const isHookDelivery = c.req.method === "POST" && c.req.path.startsWith("/hooks/");
    if (
      authToken &&
      !isHookDelivery &&
      !(c.req.method === "GET" && c.req.path === "/health")
    ) {
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
      // Derived, not asserted: a caller checking this field is asking whether
      // it can trust the data, and the runtime is the only thing that knows.
      mocked: runtime.mode === "mock",
      mode: runtime.mode,
      chainId: runtime.chainId,
      chain: { reachable: true, chainId: runtime.chainId },
      db: { configured: options.isDbConfigured(), ready: options.isDbReady() },
      queue: queue.status(),
      model: { provider: model.name },
      mcp: { tools: listLacrewMcpTools().length, useMock: mcpUseMock },
      flows: {
        saved: (await flows.list()).length,
        templates: flows.templates().length,
        store: flows.storeName,
      },
      webhooks: webhooks
        ? {
            triggers: webhooks.list().length,
            enabled: webhooks.list().filter((t) => t.enabled).length,
            store: webhooks.storeName,
            maxBodyBytes: webhookMaxBodyBytes(),
          }
        : { triggers: 0, store: null },
      heartbeats: heartbeats
        ? {
            configured: heartbeats.list().length,
            enabled: heartbeats.list().filter((h) => h.enabled).length,
            store: heartbeats.storeName,
          }
        : { configured: 0, store: null },
      // Counts, and how many of them actually bite. An `enabled` budget that is
      // `soft` bounds nothing on its own, so reporting one number would let a
      // deployment read as protected when nothing would ever be refused.
      budgets: budgets
        ? await (async () => {
            const views = await budgets.list();
            const on = views.filter((v) => v.budget.enabled);
            return {
              configured: views.length,
              enabled: on.length,
              hard: on.filter((v) => v.budget.policy === "hard").length,
              warning: on.filter((v) => v.status.state === "warning").length,
              exceeded: on.filter((v) => v.status.state === "exceeded").length,
              store: budgets.storeName,
            };
          })()
        : { configured: 0, store: null },
      auth: { required: Boolean(authToken) },
      audit: { persisted: options.isDbReady() },
      governance: { autoExecute: autoExecuteEnabled() },
      runtimeStore: runtime.runtimeStoreName,
    }),
  );

  app.post("/model/complete", async (c) => {
    const body = await bodyOf<{
      system?: string;
      prompt?: string;
      model?: string;
      /** Who to charge (F2.28). Unattributed calls are still metered. */
      crewId?: string;
      agentId?: string;
    }>(c);
    if (!body.prompt?.trim()) return jsonBig(c, { error: "prompt_required" }, 400);
    try {
      const result = await model.complete({
        system: body.system,
        prompt: body.prompt,
        model: body.model,
        meta: {
          ...(body.crewId ? { crewId: body.crewId } : {}),
          ...(body.agentId ? { agentId: body.agentId } : {}),
        },
      });
      return jsonBig(c, { ...result, provider: model.name });
    } catch (err) {
      // 429, not 400: the request is well-formed and the same call succeeds
      // once the cap is raised or the period rolls. The code is the stable one
      // flows and MCP see, so a caller branches on one string everywhere.
      if (isInferenceBudgetExceeded(err)) {
        return jsonBig(
          c,
          {
            error: err.code,
            scopeKey: err.scopeKey,
            dimension: err.dimension,
            periodKey: err.periodKey,
          },
          429,
        );
      }
      throw err;
    }
  });

  /**
   * The tools an agent can actually call: the first-party `lacrew_*` set, plus
   * whatever external MCP tools are allowlisted **for that seat** (`?as=`).
   *
   * Served together because that union is the honest answer to "what can this
   * agent do", and a surface that listed only the first-party half would tell
   * an operator their crew cannot reach GitHub while it merges pull requests.
   */
  app.get("/mcp/tools", async (c) => {
    const as = c.req.query("as");
    const subject = as ? { principal: as, managers: await managersOf(as) } : {};
    return jsonBig(c, {
      tools: listLacrewMcpTools(),
      external: externalMcp?.toolNames(subject) ?? [],
      useMock: mcpUseMock,
      mode: runtime.mode,
    });
  });

  /* ——— external MCP servers (F2.30) ——— */

  /**
   * Attached servers, their tools, and what each one resolves to for a seat.
   *
   * `?as=` for the same reason `/connectors` takes it: the workspace's answer is
   * the one nobody's flow runs under once a single seat overrides it. Every
   * response is credential-free by construction — the auth block names env vars
   * and says whether they are set, and nothing here can read a value.
   */
  app.get("/mcp/servers", async (c) => {
    if (!externalMcp) return jsonBig(c, { error: "external_mcp_unavailable" }, 503);
    const as = c.req.query("as");
    const subject = as ? { principal: as, managers: await managersOf(as) } : {};
    return jsonBig(c, {
      servers: externalMcp.describe(subject),
      rules: externalMcp.rules(),
      modes: CONNECTOR_WRITE_MODES,
    });
  });

  /**
   * Re-read tool lists. Newly seen tools are recorded **disabled**, so a
   * refresh can never widen what a crew may call — it only makes the gap
   * visible ("3 new tools blocked"). Omit `server` to sweep every one.
   */
  app.post("/mcp/servers/refresh", async (c) => {
    if (!externalMcp) return jsonBig(c, { error: "external_mcp_unavailable" }, 503);
    const body = await bodyOf<{ server?: string }>(c);
    try {
      const results = await externalMcp.refresh(body.server?.trim() || undefined);
      for (const result of results) {
        if (!result.ok) continue;
        runtime.recordAudit({
          type: "ExternalMcpDiscovered",
          at: new Date().toISOString(),
          payload: {
            server: result.server,
            added: result.added.length,
            removed: result.removed.length,
            blocked: result.added,
          },
        });
      }
      return jsonBig(c, { results });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "mcp_refresh_failed") }, 400);
    }
  });

  /** Reachability check for a setup drawer: does it answer, and with how many tools. */
  app.post("/mcp/servers/ping", async (c) => {
    if (!externalMcp) return jsonBig(c, { error: "external_mcp_unavailable" }, 503);
    const body = await bodyOf<{ server?: string }>(c);
    if (!body.server?.trim()) return jsonBig(c, { error: "server_required" }, 400);
    try {
      return jsonBig(c, await externalMcp.ping(body.server.trim()));
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "unknown_mcp_server") }, 404);
    }
  });

  /**
   * Allow, disable, or re-mode one tool. `enabled` absent **clears** the record
   * at that scope, which is not the same as disabling it: clearing drops an
   * exception so the tool inherits again, while `enabled: false` pins the
   * refusal at this scope.
   *
   * A wildcard (`tool: "*"`) is refused unless it narrows — a rule that admitted
   * every tool a server publishes would undo the one property this feature is
   * built on.
   */
  app.put("/mcp/servers/tools", async (c) => {
    if (!externalMcp) return jsonBig(c, { error: "external_mcp_unavailable" }, 503);
    const body = await bodyOf<{
      scope?: unknown;
      server?: string;
      tool?: string;
      enabled?: boolean | null;
      effect?: string;
      mode?: string;
    }>(c);
    // An omitted scope is the workspace. A *malformed* one is a 400 rather than
    // the same default: silently widening a rule somebody meant for one seat
    // into one for the whole workspace is the wrong direction to fail in.
    const scope = body.scope === undefined ? { level: "workspace" as const } : parseModeScope(body.scope);
    if (!scope) return jsonBig(c, { error: "scope must be workspace, crew:<ref>, or agent:<ref>" }, 400);
    const server = body.server?.trim() ?? "";
    const tool = body.tool?.trim() ?? "";
    if (!server || !tool) return jsonBig(c, { error: "server_and_tool_required" }, 400);

    if (body.enabled === null || body.enabled === undefined) {
      const cleared = await externalMcp.clearTool(scope, server, tool);
      if (cleared) {
        runtime.recordAudit({
          type: "ExternalMcpToolPolicyChanged",
          at: new Date().toISOString(),
          payload: { scope, server, tool, action: "cleared" },
        });
      }
      return jsonBig(c, { cleared, rules: externalMcp.rules() });
    }

    const rule: ExternalMcpToolRule = {
      scope,
      server,
      tool,
      enabled: body.enabled === true,
      ...(body.effect === "read" || body.effect === "write" ? { effect: body.effect } : {}),
      ...(body.mode ? { mode: body.mode as ExternalMcpToolRule["mode"] } : {}),
    };
    const invalid = validateExternalMcpRule(rule);
    if (invalid.length > 0) return jsonBig(c, { error: invalid.join("; ") }, 400);
    if (rule.mode && !isConnectorWriteMode(rule.mode)) {
      return jsonBig(c, { error: `mode must be ${CONNECTOR_WRITE_MODES.join(" | ")}` }, 400);
    }
    try {
      const record = await externalMcp.setTool(rule);
      runtime.recordAudit({
        type: "ExternalMcpToolPolicyChanged",
        at: record.at,
        payload: {
          scope,
          server,
          tool,
          enabled: record.enabled,
          ...(record.effect ? { effect: record.effect } : {}),
          ...(record.mode ? { mode: record.mode } : {}),
          action: record.enabled ? "allowed" : "disabled",
        },
      });
      return jsonBig(c, { rule: record, rules: externalMcp.rules() });
    } catch (err) {
      const message = msgOf(err, "invalid_mcp_tool_rule");
      return jsonBig(c, { error: message }, message.startsWith("unknown_mcp_server") ? 404 : 400);
    }
  });

  /**
   * Wiring state for the external surfaces this orchestrator can reach.
   *
   * An operator surface has no other way to answer "is GitHub actually hooked
   * up?" — connectors are env-configured, so a control plane could only guess.
   * The response carries route shapes, which env vars each connector reads,
   * and whether they are set; never a credential value, and never a token. It
   * also lists the presets that ship but are not registered, because "you
   * could add this" and "this is wired" are different answers and a catalog
   * that conflates them is how an operator thinks a crew can merge when it
   * cannot.
   */
  app.get("/connectors", async (c) => {
    // `?as=` asks the question an operator actually has: what mode would *this
    // seat* run under. Without it the answer is the workspace's, which is the
    // one nobody's flow runs under once a single override exists. The chart is
    // read for the same reason: a crew rule applies through the reporting line,
    // so resolving without the ancestors would show a rule that does not exist.
    const as = c.req.query("as");
    const registered = connectors?.describe(as ? { principal: as, managers: await managersOf(as) } : {}) ?? [];
    const live = new Set(registered.map((r) => r.id));
    return jsonBig(c, {
      connectors: registered,
      available: connectorPresets
        .filter((p) => !live.has(p.id))
        .map((p) => ({
          id: p.id,
          title: p.title,
          summary: p.summary,
          // Null rather than absent, with the note beside it: a preset whose
          // host is the operator's own (a Ghost blog) will not build without
          // one, and a catalog that simply omitted the field would read as
          // "no base URL needed".
          baseUrl: p.baseUrl ?? null,
          ...(p.baseUrl === undefined ? { baseUrlRequired: true, baseUrlNote: p.baseUrlNote } : {}),
          ...(p.headers ? { headers: p.headers } : {}),
          auth: p.auth,
          routes: p.routes.map((r) => ({
            name: r.name,
            method: r.method,
            path: r.path,
            ...(r.description ? { description: r.description } : {}),
            effect: r.effect,
            params: r.params ?? [],
            requiresPolicyTarget: Boolean(r.policyTarget?.required),
            ...(r.policyTarget ? { policyTargetNote: r.policyTarget.note } : {}),
            // The mode this route would ship with, so the catalog says what
            // registering it actually turns on rather than leaving an operator
            // to discover their first merge stopped for a question.
            defaultMode: r.effect === "write" ? (r.mode ?? "auto") : null,
          })),
        })),
      mode: runtime.mode,
    });
  });

  /* ——— connector write policy (F2.24) ——— */

  /**
   * The rules narrowing write routes, and the vocabulary a UI renders.
   *
   * Served whole rather than per-connector: a rule may name a route whose
   * connector is not registered in this process, and hiding those would make an
   * operator's own configuration invisible to them.
   */
  app.get("/connectors/modes", (c) =>
    connectorModes
      ? jsonBig(c, { rules: connectorModes.list(), modes: CONNECTOR_WRITE_MODES })
      : jsonBig(c, { error: "connector_modes_unavailable" }, 503),
  );

  /**
   * Set or clear one rule. `mode` absent clears it, falling the route back to
   * what it inherits — which is not the same as setting `auto`, and the two are
   * kept distinct so an operator can remove an exception rather than pin it.
   */
  app.put("/connectors/modes", async (c) => {
    if (!connectorModes) return jsonBig(c, { error: "connector_modes_unavailable" }, 503);
    const body = await bodyOf<{ scope?: unknown; route?: string; mode?: string | null }>(c);
    const scope = parseModeScope(body.scope);
    if (!scope) return jsonBig(c, { error: "scope_required" }, 400);
    const route = body.route?.trim() ?? "";
    const invalid = validateModeRoute(route);
    if (invalid) return jsonBig(c, { error: invalid }, 400);

    if (body.mode === null || body.mode === undefined) {
      const cleared = await connectorModes.clear(scope, route);
      if (cleared) {
        runtime.recordAudit({
          type: "ConnectorWritePolicyChanged",
          at: new Date().toISOString(),
          payload: { scope, route, mode: null, action: "cleared" },
        });
      }
      return jsonBig(c, { cleared, rules: connectorModes.list() });
    }
    if (!isConnectorWriteMode(body.mode)) {
      return jsonBig(
        c,
        { error: `mode must be ${CONNECTOR_WRITE_MODES.join(" | ")}` },
        400,
      );
    }
    try {
      const rule = await connectorModes.set({ scope, route, mode: body.mode });
      runtime.recordAudit({
        type: "ConnectorWritePolicyChanged",
        at: rule.at,
        payload: { scope, route, mode: rule.mode, action: "set" },
      });
      return jsonBig(c, { rule, rules: connectorModes.list() });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "invalid_connector_mode") }, 400);
    }
  });

  /**
   * Ask-mode confirmations. `?status=pending` is the queue a human works from;
   * the resolved ones stay readable because "who said yes to that merge" is the
   * question asked after the fact, not before.
   */
  app.get("/connectors/asks", (c) => {
    if (!connectorAsks) return jsonBig(c, { error: "connector_asks_unavailable" }, 503);
    const status = c.req.query("status");
    const all = connectorAsks.list();
    return jsonBig(c, {
      asks: status ? all.filter((a) => a.status === status) : all,
      // Answering happens through the thread, not here: a route that resolved
      // an ask directly would be a second, unauthenticated-by-conversation way
      // to release a write.
      answerVia: "POST /messages with kind=answer, replyTo=<questionId>, body=yes|no",
    });
  });

  /**
   * Blocking human gates (F2.27). `?status=pending` is the queue of runs that
   * are actually stopped, which is the distinction a Questions rail needs: an
   * informational ask can wait, a gate is holding a pipeline.
   */
  app.get("/flows/gates", (c) => {
    if (!humanGates) return jsonBig(c, { error: "human_gates_unavailable" }, 503);
    const status = c.req.query("status");
    const runId = c.req.query("runId");
    let all = humanGates.list();
    if (status) all = all.filter((g) => g.status === status);
    if (runId) all = all.filter((g) => g.runId === runId);
    return jsonBig(c, {
      gates: all,
      // Answering happens through the thread, not here: a route that resolved a
      // gate directly would be a second way to release a paused pipeline, and
      // one that never sees whether the answer came from a human seat.
      answerVia:
        "POST /messages with kind=answer, replyTo=<questionId>, body=<option id>, as a human seat",
    });
  });

  app.post("/mcp/call", async (c) => {
    const body = await bodyOf<{
      name?: string;
      arguments?: Record<string, unknown>;
      as?: string;
    }>(c);
    if (!body.name?.trim()) return jsonBig(c, { error: "name_required" }, 400);
    // An external tool goes through the allowlist like any other caller would:
    // this route is how an operator tries one out, not a way around the policy.
    // `as` resolves the seat's rules; without it the workspace's apply.
    if (externalMcp?.handles(body.name)) {
      const as = body.as?.trim();
      try {
        const result = await externalMcp.call(body.name, body.arguments ?? {}, {
          ...(as ? { principal: as, managers: await managersOf(as) } : {}),
        });
        return jsonBig(c, { name: body.name, result, mode: runtime.mode });
      } catch (err) {
        const message = msgOf(err, "external_mcp_call_failed");
        const refused =
          message.startsWith("tool_not_allowlisted") || message.startsWith("mcp_mode_denied");
        // An ask-mode write did not fail — it asked. Reported as 202 with the
        // question's id, because a 5xx here reads as "the server broke" for the
        // one outcome the operator configured on purpose.
        if (message.startsWith("flow_waiting:connector_ask")) {
          return jsonBig(
            c,
            {
              status: "waiting",
              reason: "connector_ask",
              askId: message.split(":").at(-1),
              detail: "a human was asked to confirm this write; nothing was called",
            },
            202,
          );
        }
        return jsonBig(c, { error: message }, refused ? 403 : 502);
      }
    }
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

  /**
   * Runs that have not finished: parked on a human or an event, or in flight.
   * The stalled-run list an operator scans — a run waiting three days on a
   * confirmation nobody saw is invisible in the run ring once it scrolls off.
   */
  app.get("/flows/runs/open", async (c) =>
    jsonBig(c, { runs: await flows.openRuns(), mode: runtime.mode }),
  );

  /** Where one run is, plus the checkpoint trail that got it there. */
  app.get("/flows/runs/state", async (c) => {
    const runId = c.req.query("runId");
    if (!runId) return jsonBig(c, { error: "runId_required" }, 400);
    const state = await flows.runState(runId);
    if (!state) return jsonBig(c, { error: "run_not_found" }, 404);
    return jsonBig(c, { state, checkpoints: await flows.checkpoints(runId) });
  });

  /**
   * Pause / resume / cancel (F2.26). The status codes matter to a caller: 404
   * is a run nobody has heard of, 409 is a run whose own state refuses the
   * change — a cancelled run asked to resume, a finished run asked to pause.
   */
  const lifecycleRoute = (
    path: string,
    act: (runId: string, detail?: string) => Promise<unknown>,
  ): void => {
    app.post(path, async (c) => {
      const body = await bodyOf<{ runId?: string; reason?: string }>(c);
      if (!body.runId) return jsonBig(c, { error: "runId_required" }, 400);
      try {
        return jsonBig(c, await act(body.runId, body.reason));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "flow_run_lifecycle_failed";
        const status = msg === "run_not_found" ? 404 : 409;
        return jsonBig(c, { error: msg }, status);
      }
    });
  };
  lifecycleRoute("/flows/runs/pause", (runId, reason) => flows.pause(runId, reason));
  lifecycleRoute("/flows/runs/resume", (runId) => flows.resume(runId));
  lifecycleRoute("/flows/runs/cancel", (runId, reason) => flows.cancel(runId, reason));

  /* ——— eval suite (F2.29) ——— */

  /**
   * The scenarios this build ships, so a surface can offer them by name without
   * running anything. Filterable by the flow or blueprint they exercise, which
   * is how a crew page asks "what is there for *this* desk".
   */
  app.get("/flows/eval", async (c) => {
    if (!evals) return jsonBig(c, { error: "evals_unavailable" }, 503);
    const flow = c.req.query("flow");
    const blueprint = c.req.query("blueprint");
    try {
      const scenarios = await evals.list();
      return jsonBig(c, {
        scenarios: scenarios.filter(
          (s) => (!flow || s.flow === flow) && (!blueprint || s.blueprint === blueprint),
        ),
        running: evals.busy(),
      });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "eval_list_failed") }, 500);
    }
  });

  /**
   * Run scenarios and report what they asserted.
   *
   * Runs in a child process (`evalRunner.ts`) so the harness's network block
   * cannot reach the calls this orchestrator is making for real crews. One run
   * at a time: a second is refused with 409 rather than queued, because the
   * caller is waiting for an answer about the state of things now.
   */
  app.post("/flows/eval", async (c) => {
    if (!evals) return jsonBig(c, { error: "evals_unavailable" }, 503);
    const body = await bodyOf<{ ids?: string[]; flow?: string; blueprint?: string }>(c);
    try {
      const result = await evals.run({
        ...(Array.isArray(body.ids) ? { ids: body.ids.map(String) } : {}),
        ...(body.flow ? { flow: String(body.flow) } : {}),
        ...(body.blueprint ? { blueprint: String(body.blueprint) } : {}),
      });
      runtime.recordAudit({
        type: "FlowEvalRun",
        at: new Date().toISOString(),
        payload: {
          ...(body.flow ? { flow: body.flow } : {}),
          ...(body.blueprint ? { blueprint: body.blueprint } : {}),
          matched: result.matched,
          passed: result.passed,
          failed: result.failed,
          ms: result.ms,
        },
      });
      return jsonBig(c, result);
    } catch (err) {
      const message = msgOf(err, "eval_failed");
      // A run already in flight is not a bad request and not a fault: the same
      // call succeeds once it finishes.
      const status = message === "eval_already_running" ? 409 : message === "eval_timeout" ? 504 : 500;
      return jsonBig(c, { error: message }, status);
    }
  });

  app.get("/flows/templates", (c) => jsonBig(c, { templates: flows.templates() }));

  /**
   * Webhook flow triggers (F2.22). The management routes sit behind the normal
   * bearer token; only `POST /hooks/:triggerId` is carved out of it, because
   * its caller is an external producer authenticating with an HMAC instead.
   */
  app.get("/flows/triggers", (c) =>
    webhooks
      ? jsonBig(c, {
          triggers: webhooks.list(),
          store: webhooks.storeName,
          maxBodyBytes: webhookMaxBodyBytes(),
          // Served rather than duplicated by consumers: a control plane that
          // hardcoded this list would offer a source the orchestrator it is
          // talking to cannot actually verify.
          sources: describeEventSources(),
        })
      : jsonBig(c, { error: "webhooks_unavailable" }, 503),
  );

  app.post("/flows/triggers", async (c) => {
    if (!webhooks) return jsonBig(c, { error: "webhooks_unavailable" }, 503);
    const body = await bodyOf<{
      flowId?: string;
      principal?: `0x${string}`;
      scheme?: EventSourceId;
      input?: WebhookInputMap;
      description?: string;
      secret?: string;
    }>(c);
    if (!body.flowId?.trim()) return jsonBig(c, { error: "flow_id_required" }, 400);
    try {
      const { trigger, secret } = await webhooks.create({ ...body, flowId: body.flowId });
      // The only time the secret is ever served. It is sealed at rest and the
      // process holds it to verify with; there is no read-it-back route.
      return jsonBig(c, { trigger, secret, secretShownOnce: true }, 201);
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "invalid_trigger") }, triggerErrorStatus(err));
    }
  });

  app.post("/flows/triggers/rotate", async (c) => {
    if (!webhooks) return jsonBig(c, { error: "webhooks_unavailable" }, 503);
    const body = await bodyOf<{ id?: string; secret?: string }>(c);
    if (!body.id) return jsonBig(c, { error: "id_required" }, 400);
    try {
      const { trigger, secret } = await webhooks.rotate(body.id, body.secret);
      return jsonBig(c, { trigger, secret, secretShownOnce: true });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "rotate_failed") }, triggerErrorStatus(err));
    }
  });

  app.post("/flows/triggers/enabled", async (c) => {
    if (!webhooks) return jsonBig(c, { error: "webhooks_unavailable" }, 503);
    const body = await bodyOf<{ id?: string; enabled?: boolean }>(c);
    if (!body.id) return jsonBig(c, { error: "id_required" }, 400);
    if (typeof body.enabled !== "boolean") return jsonBig(c, { error: "enabled_required" }, 400);
    try {
      return jsonBig(c, { trigger: await webhooks.setEnabled(body.id, body.enabled) });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "update_failed") }, triggerErrorStatus(err));
    }
  });

  app.post("/flows/triggers/delete", async (c) => {
    if (!webhooks) return jsonBig(c, { error: "webhooks_unavailable" }, 503);
    const body = await bodyOf<{ id?: string }>(c);
    if (!body.id) return jsonBig(c, { error: "id_required" }, 400);
    return jsonBig(c, { removed: await webhooks.remove(body.id) });
  });

  app.get("/flows/triggers/deliveries", async (c) => {
    if (!webhooks) return jsonBig(c, { error: "webhooks_unavailable" }, 503);
    const limit = Number(c.req.query("limit") ?? 50);
    return jsonBig(c, {
      deliveries: await webhooks.deliveries(
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
        c.req.query("triggerId") ?? undefined,
      ),
    });
  });

  /**
   * The hook surface itself. Reads the raw body — not `bodyOf` — because the
   * HMAC covers the exact bytes sent, and re-serializing a parsed object would
   * verify a different string than the producer signed.
   */
  app.post("/hooks/:triggerId", async (c) => {
    if (!webhooks) return jsonBig(c, { error: "webhooks_unavailable" }, 503);
    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    // Refuse on the declared length before reading, so an oversized body is
    // never buffered in the first place.
    if (Number.isFinite(declared) && declared > webhookMaxBodyBytes()) {
      return jsonBig(c, { error: "webhook_body_too_large" }, 413);
    }
    const rawBody = await c.req.text().catch(() => "");
    const accepted = await webhooks.accept({
      triggerId: c.req.param("triggerId"),
      rawBody,
      header: (name) => c.req.header(name),
      ...(Number.isFinite(declared) ? { contentLength: declared } : {}),
    });
    if (!accepted.ok) return jsonBig(c, { error: accepted.error }, accepted.status);
    if ("skipped" in accepted) {
      return jsonBig(
        c,
        {
          accepted: true,
          skipped: accepted.skipped,
          ...(accepted.eventType ? { eventType: accepted.eventType } : {}),
        },
        200,
      );
    }
    if ("duplicate" in accepted) {
      return jsonBig(c, { accepted: true, duplicate: true, deliveryKey: accepted.deliveryKey }, 200);
    }
    return jsonBig(
      c,
      { accepted: true, runId: accepted.runId, deliveryKey: accepted.deliveryKey },
      202,
    );
  });

  /**
   * Crew heartbeats (F2.21) — the standing checklist a crew works through on
   * its own cadence. Every route here edits or inspects a *declaration*; the
   * only one that causes work is `run`, and it runs exactly what the checklist
   * already named.
   */
  app.get("/heartbeats", async (c) => {
    if (!heartbeats) return jsonBig(c, { error: "heartbeats_unavailable" }, 503);
    return jsonBig(c, {
      heartbeats: heartbeats.list(),
      presets: HEARTBEAT_PRESETS,
      minIntervalMinutes: HEARTBEAT_MIN_INTERVAL_MINUTES,
      maxItems: HEARTBEAT_MAX_ITEMS,
      store: heartbeats.storeName,
    });
  });

  app.post("/heartbeats", async (c) => {
    if (!heartbeats) return jsonBig(c, { error: "heartbeats_unavailable" }, 503);
    const body = await bodyOf<{ heartbeat?: Partial<CrewHeartbeat> & { crewId?: string } }>(c);
    const input = body.heartbeat;
    if (!input?.crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    try {
      return jsonBig(c, {
        heartbeat: await heartbeats.save({ ...input, crewId: input.crewId }),
      });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "invalid_heartbeat") }, heartbeatErrorStatus(err));
    }
  });

  app.post("/heartbeats/enabled", async (c) => {
    if (!heartbeats) return jsonBig(c, { error: "heartbeats_unavailable" }, 503);
    const body = await bodyOf<{ crewId?: string; enabled?: boolean }>(c);
    if (!body.crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    if (typeof body.enabled !== "boolean") {
      return jsonBig(c, { error: "enabled_must_be_boolean" }, 400);
    }
    try {
      return jsonBig(c, {
        heartbeat: await heartbeats.setEnabled(body.crewId, body.enabled),
      });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "invalid_heartbeat") }, heartbeatErrorStatus(err));
    }
  });

  app.post("/heartbeats/delete", async (c) => {
    if (!heartbeats) return jsonBig(c, { error: "heartbeats_unavailable" }, 503);
    const body = await bodyOf<{ crewId?: string }>(c);
    if (!body.crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    return jsonBig(c, { removed: await heartbeats.remove(body.crewId) });
  });

  /**
   * Work the checklist now. Fires whatever the list names, whatever the clock
   * says — an operator pressing this is being explicit, and a config they
   * cannot test until 03:00 is one they cannot check at all. It takes its own
   * window key so it never suppresses the scheduled tick it was testing.
   */
  app.post("/heartbeats/run", async (c) => {
    if (!heartbeats) return jsonBig(c, { error: "heartbeats_unavailable" }, 503);
    const body = await bodyOf<{ crewId?: string }>(c);
    if (!body.crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    try {
      return jsonBig(c, { tick: await heartbeats.runNow(body.crewId) });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "heartbeat_failed") }, heartbeatErrorStatus(err));
    }
  });

  app.get("/heartbeats/ticks", async (c) => {
    if (!heartbeats) return jsonBig(c, { error: "heartbeats_unavailable" }, 503);
    const limit = Number(c.req.query("limit") ?? 20);
    return jsonBig(c, {
      ticks: await heartbeats.ticks(
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 20,
        c.req.query("crewId") ?? undefined,
      ),
    });
  });

  /**
   * Inference & API cost budgets (F2.28).
   *
   * Every route here reads or edits an *operational* limit on model spend. None
   * of them moves funds, changes a policy stack, or touches an allowance — a
   * crew that has burned its inference budget can still propose a spend, and
   * that spend is judged exactly as before. Raising a cap is the one action
   * that lets a stopped crew spend again, so it is audited.
   */
  app.get("/budgets", async (c) => {
    if (!budgets) return jsonBig(c, { error: "budgets_unavailable" }, 503);
    return jsonBig(c, {
      budgets: await budgets.list(),
      warnRatio: INFERENCE_BUDGET_WARN_RATIO,
      store: budgets.storeName,
    });
  });

  /**
   * One budget with its live standing. `agentId` asks about that seat's own
   * budget, not the crew budget it also sits under — the two are separate rows
   * and conflating them would report a limit nobody set on that seat.
   */
  app.get("/budgets/one", async (c) => {
    if (!budgets) return jsonBig(c, { error: "budgets_unavailable" }, 503);
    const crewId = c.req.query("crewId");
    if (!crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    const view = await budgets.get({
      crewId,
      ...(c.req.query("agentId") ? { agentId: c.req.query("agentId")! } : {}),
    });
    if (!view) return jsonBig(c, { error: "budget_not_found" }, 404);
    return jsonBig(c, { budget: view });
  });

  app.post("/budgets", async (c) => {
    if (!budgets) return jsonBig(c, { error: "budgets_unavailable" }, 503);
    const body = await bodyOf<{ budget?: Partial<InferenceBudget> & { crewId?: string } }>(c);
    const input = body.budget;
    if (!input?.crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    try {
      const budget = await budgets.save({ ...input, crewId: input.crewId });
      runtime.recordAudit({
        type: "InferenceBudgetChanged",
        at: budget.updatedAt,
        payload: {
          crewId: budget.crewId,
          ...(budget.agentId ? { agentId: budget.agentId } : {}),
          action: "saved",
          period: budget.period,
          policy: budget.policy,
          // Numbers an operator typed. No prompt, no key, nothing from a call.
          limits: budget.limits,
          enabled: budget.enabled,
        },
      });
      return jsonBig(c, { budget });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "invalid_inference_budget") }, 400);
    }
  });

  app.post("/budgets/enabled", async (c) => {
    if (!budgets) return jsonBig(c, { error: "budgets_unavailable" }, 503);
    const body = await bodyOf<{ crewId?: string; agentId?: string; enabled?: boolean }>(c);
    if (!body.crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    if (typeof body.enabled !== "boolean") {
      return jsonBig(c, { error: "enabled_must_be_boolean" }, 400);
    }
    try {
      const budget = await budgets.setEnabled(
        { crewId: body.crewId, ...(body.agentId ? { agentId: body.agentId } : {}) },
        body.enabled,
      );
      runtime.recordAudit({
        type: "InferenceBudgetChanged",
        at: budget.updatedAt,
        payload: {
          crewId: budget.crewId,
          ...(budget.agentId ? { agentId: budget.agentId } : {}),
          action: body.enabled ? "enabled" : "disabled",
          policy: budget.policy,
          limits: budget.limits,
        },
      });
      return jsonBig(c, { budget });
    } catch (err) {
      const msg = msgOf(err, "invalid_inference_budget");
      return jsonBig(c, { error: msg }, msg.startsWith("unknown_inference_budget") ? 404 : 400);
    }
  });

  app.post("/budgets/delete", async (c) => {
    if (!budgets) return jsonBig(c, { error: "budgets_unavailable" }, 503);
    const body = await bodyOf<{ crewId?: string; agentId?: string }>(c);
    if (!body.crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    const subject = {
      crewId: body.crewId,
      ...(body.agentId ? { agentId: body.agentId } : {}),
    };
    const removed = await budgets.remove(subject);
    if (removed) {
      runtime.recordAudit({
        type: "InferenceBudgetChanged",
        at: new Date().toISOString(),
        payload: { ...subject, action: "removed" },
      });
    }
    return jsonBig(c, { removed });
  });

  /**
   * The calls behind the number. Model id, tokens, estimated USD and the run
   * that made each one — so "why is this crew at 90%?" is answerable without
   * reading a provider's console.
   */
  app.get("/budgets/usage", async (c) => {
    if (!budgets) return jsonBig(c, { error: "budgets_unavailable" }, 503);
    const crewId = c.req.query("crewId");
    if (!crewId?.trim()) return jsonBig(c, { error: "crewId_required" }, 400);
    const subject = {
      crewId,
      ...(c.req.query("agentId") ? { agentId: c.req.query("agentId")! } : {}),
    };
    const limit = Number(c.req.query("limit") ?? 100);
    return jsonBig(c, {
      budget: await budgets.get(subject),
      events: await budgets.events(
        subject,
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100,
      ),
    });
  });

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
      window?: { start: number; end: number };
      rate?: { maxProposals: number; ratePeriod: number };
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

    // Validated here so a bad window/rate is a 400, not a chain revert far from
    // the caller. The chain checks them again at issue.
    if (body.window !== undefined) {
      const { start, end } = body.window;
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end > 86400) {
        return jsonBig(c, { error: "invalid_window: need integers 0 <= start < end <= 86400" }, 400);
      }
    }
    if (body.rate !== undefined) {
      const { maxProposals, ratePeriod } = body.rate;
      if (!Number.isInteger(maxProposals) || !Number.isInteger(ratePeriod) || maxProposals <= 0 || ratePeriod <= 0) {
        return jsonBig(c, { error: "invalid_rate: need positive integers maxProposals and ratePeriod" }, 400);
      }
    }

    const session = await runtime.boot(body.agent as `0x${string}` | undefined, {
      scopes,
      maxValue: body.maxValue ? BigInt(body.maxValue) : undefined,
      allowedTarget: body.allowedTarget as `0x${string}` | undefined,
      window: body.window,
      rate: body.rate,
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

  /* ——— standing agent controls (F1.7) ——— */

  app.get("/agents/controls", async (c) =>
    jsonBig(c, {
      paused: runtime.listPausedAgents(),
      briefs: runtime.listAgentBriefs(),
      // False when stored controls were never read — an empty list then means
      // "unknown", not "nothing is paused and nobody is briefed".
      hydrated: runtime.agentControlsHydrated,
      mode: runtime.mode,
    }),
  );

  /**
   * Stop an agent acting through this orchestrator: no new session keys, and
   * every live one revoked. Deliberately not 500 on a partial revoke — the
   * gate holds either way, and the caller is told exactly which keys survived
   * so it can say so rather than reporting an unknown state.
   */
  app.post("/agents/pause", async (c) => {
    const body = await bodyOf<{ agent?: string; reason?: string }>(c);
    if (!body.agent) return jsonBig(c, { error: "agent_required" }, 400);
    const agent = body.agent as `0x${string}`;
    const result = await runtime.pauseAgent(agent, body.reason);
    // A run parked on a human is authority waiting to be spent, and pausing an
    // agent is an operator saying it should spend none. Leaving its paused runs
    // resumable would make the pause a delay rather than a stop, so they are
    // cancelled here with the reason attached (F2.26).
    const wanted = agent.toLowerCase();
    const cancelled: string[] = [];
    for (const state of await flows.openRuns()) {
      if (state.status !== "waiting") continue;
      if ((state.principal ?? "").toLowerCase() !== wanted) continue;
      try {
        await flows.cancel(state.runId, `principal paused${body.reason ? `: ${body.reason}` : ""}`);
        cancelled.push(state.runId);
      } catch (err) {
        console.error(
          `[@lacrew/orchestrator] could not cancel run ${state.runId} for paused agent ${agent}:`,
          err,
        );
      }
    }
    return jsonBig(c, { ...result, cancelledRuns: cancelled, mode: runtime.mode });
  });

  app.post("/agents/resume", async (c) => {
    const body = await bodyOf<{ agent?: string }>(c);
    if (!body.agent) return jsonBig(c, { error: "agent_required" }, 400);
    return jsonBig(c, { ...runtime.resumeAgent(body.agent as `0x${string}`), mode: runtime.mode });
  });

  /**
   * Replace an agent's standing brief. Layers are applied in the order given
   * and their labels are stored, never interpreted — see agentControls.ts.
   *
   * A layer carries three things and all three are read here. Taking only
   * `text` would make every save through this route a silent uninstall of the
   * resources and skills the layer already had, which is how an installed pack
   * disappears the next time somebody edits the guidelines above it.
   */
  app.put("/agents/brief", async (c) => {
    const body = await bodyOf<{
      agent?: string;
      layers?: Array<{
        label?: string;
        text?: string;
        resources?: Array<{ kind?: string; ref?: string; note?: string }>;
        skills?: Array<{
          name?: string;
          when?: string;
          instructions?: string;
          source?: { pack?: string; version?: string; skill?: string };
        }>;
      }>;
    }>(c);
    if (!body.agent) return jsonBig(c, { error: "agent_required" }, 400);
    if (!Array.isArray(body.layers)) return jsonBig(c, { error: "layers_required" }, 400);
    const layers = body.layers.map((l) => ({
      label: String(l.label ?? ""),
      text: String(l.text ?? ""),
      resources: (Array.isArray(l.resources) ? l.resources : []).map((r) => ({
        kind: String(r.kind ?? ""),
        ref: String(r.ref ?? ""),
        ...(r.note ? { note: String(r.note) } : {}),
      })),
      skills: (Array.isArray(l.skills) ? l.skills : []).map((s) => ({
        name: String(s.name ?? ""),
        ...(s.when ? { when: String(s.when) } : {}),
        instructions: String(s.instructions ?? ""),
        // Provenance round-trips so an edit through the directive editor does
        // not orphan a pack's skills from the pack that installed them.
        ...(s.source?.pack && s.source.skill
          ? {
              source: {
                pack: String(s.source.pack),
                version: String(s.source.version ?? ""),
                skill: String(s.source.skill),
              },
            }
          : {}),
      })),
    }));
    try {
      const brief = runtime.setAgentBrief(body.agent as `0x${string}`, layers);
      return jsonBig(c, {
        agent: body.agent,
        brief,
        systemPrompt: runtime.systemPromptFor(body.agent),
        mode: runtime.mode,
      });
    } catch (err) {
      return jsonBig(c, { error: err instanceof Error ? err.message : "brief_failed" }, 400);
    }
  });

  /* ——— skill packs (F2.23) ——— */

  const skillPacks = createSkillPacksSurface({
    runtime,
    listFlowIds: async () => (await flows.list()).map((f) => f.id),
    listConnectors: () => ({
      ids: connectors?.list().map((conn) => conn.id) ?? [],
      tools: connectors?.toolNames() ?? [],
    }),
    listMcpTools: () => listLacrewMcpTools().map((tool) => tool.name),
  });

  /**
   * The packs that ship, each with what it needs and whether this deployment
   * has it.
   *
   * The readiness is computed rather than stored: a connector registered after
   * this list was last read must not leave a pack showing as uninstallable, and
   * a credential unset since must not leave one showing as ready.
   */
  app.get("/skills/packs", async (c) => {
    const available = await skillPacks.availability();
    return jsonBig(c, {
      packs: firstPartySkillPacks.map((pack) => {
        const missing = missingRequirements(pack, available);
        return {
          id: pack.id,
          version: pack.version,
          name: pack.name,
          summary: pack.summary,
          scope: pack.scope,
          skills: pack.skills.map((s) => ({ id: s.id, name: s.name, trigger: s.trigger })),
          requires: pack.requires ?? {},
          missing,
          installable: missing.flows.length + missing.connectors.length + missing.mcpTools.length === 0,
        };
      }),
      available,
      mode: runtime.mode,
    });
  });

  /** Which packs one agent's directive currently carries. */
  app.get("/agents/skills", async (c) => {
    const agent = c.req.query("agent");
    if (!agent) return jsonBig(c, { error: "agent_required" }, 400);
    return jsonBig(c, {
      agent,
      packs: skillPacks.installed(agent as `0x${string}`),
      brief: runtime.agentBrief(agent as `0x${string}`),
      mode: runtime.mode,
    });
  });

  /**
   * Install a pack onto an agent's directive — either one that ships (`packId`)
   * or one the caller supplies inline (`pack`), which is the path a file, an
   * export, or a marketplace payload takes.
   *
   * Three refusals, each with its own status because they need different
   * fixes: a malformed pack is 400, a requirement this deployment does not
   * meet is 409 (register the thing, then retry), and a directive that would
   * blow its rendered ceiling is 413.
   */
  app.post("/agents/skills/install", async (c) => {
    const body = await bodyOf<{ agent?: string; packId?: string; pack?: unknown; label?: string }>(c);
    if (!body.agent) return jsonBig(c, { error: "agent_required" }, 400);

    let pack: SkillPack | undefined;
    if (body.pack !== undefined) {
      const read = readSkillPack(body.pack);
      if (!read.pack) return jsonBig(c, { error: "invalid_skill_pack", errors: read.errors }, 400);
      pack = read.pack;
    } else if (body.packId) {
      pack = getSkillPack(body.packId);
      if (!pack) return jsonBig(c, { error: `unknown_skill_pack: ${body.packId}` }, 404);
    } else {
      return jsonBig(c, { error: "pack_or_packId_required" }, 400);
    }

    try {
      const report = await skillPacks.install(body.agent as `0x${string}`, pack, {
        ...(body.label ? { label: body.label } : {}),
      });
      return jsonBig(c, {
        ...report,
        systemPrompt: runtime.systemPromptFor(body.agent),
        mode: runtime.mode,
      });
    } catch (err) {
      if (err instanceof SkillPackRequirementsError) {
        return jsonBig(c, { error: err.message, pack: err.pack, missing: err.missing }, 409);
      }
      if (err instanceof SkillPackTooLargeError) {
        return jsonBig(c, { error: err.message, pack: err.pack, chars: err.chars }, 413);
      }
      return jsonBig(c, { error: msgOf(err, "skill_pack_install_failed") }, 400);
    }
  });

  /** Remove every skill a pack installed, leaving hand-written ones in place. */
  app.post("/agents/skills/remove", async (c) => {
    const body = await bodyOf<{ agent?: string; packId?: string }>(c);
    if (!body.agent) return jsonBig(c, { error: "agent_required" }, 400);
    if (!body.packId) return jsonBig(c, { error: "packId_required" }, 400);
    try {
      const result = skillPacks.remove(body.agent as `0x${string}`, body.packId);
      return jsonBig(c, {
        ...result,
        brief: runtime.agentBrief(body.agent as `0x${string}`),
        mode: runtime.mode,
      });
    } catch (err) {
      return jsonBig(c, { error: msgOf(err, "skill_pack_remove_failed") }, 400);
    }
  });

  /* ——— conversation (F1.7) ——— */

  app.get("/messages", async (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const threadId = c.req.query("thread");
    if (threadId) {
      const scope = scopeOfThread(threadId);
      if (!scope) return jsonBig(c, { error: "unknown_thread" }, 400);
      return jsonBig(c, {
        thread: threadId,
        messages: runtime.thread(scope, limit),
        openQuestions: runtime.openQuestions(scope),
        mode: runtime.mode,
      });
    }
    return jsonBig(c, {
      messages: runtime.recentMessages(limit),
      threads: runtime.listThreads(),
      // Every unanswered question, so a caller can show the queue without
      // reading each thread to find out one was waiting.
      openQuestions: runtime.allOpenQuestions(),
      mode: runtime.mode,
    });
  });

  /**
   * Post a message. Never a decision: this endpoint returns no verdict and
   * grants no authority, and a caller routing an approval through it has
   * reintroduced the trust the protocol exists to remove.
   */
  app.post("/messages", async (c) => {
    const body = await bodyOf<{
      thread?: string;
      author?: string;
      authorKind?: string;
      kind?: string;
      body?: string;
      options?: string[];
      replyTo?: string;
      to?: string;
      refs?: Array<{ kind?: string; id?: string }>;
      blocks?: unknown[];
      via?: string;
    }>(c);
    if (!body.thread) return jsonBig(c, { error: "thread_required" }, 400);
    if (!body.author) return jsonBig(c, { error: "author_required" }, 400);
    if (!body.body) return jsonBig(c, { error: "body_required" }, 400);
    const scope = scopeOfThread(body.thread);
    if (!scope) return jsonBig(c, { error: "unknown_thread" }, 400);
    try {
      const message = runtime.postMessage({
        scope,
        author: body.author,
        authorKind: body.authorKind === "human" ? "human" : "agent",
        kind: body.kind,
        body: body.body,
        options: body.options,
        replyTo: body.replyTo,
        to: body.to,
        blocks: body.blocks,
        // Where it came from, when the caller bridged it in from somewhere the
        // app is not (F2.19). Dropped unless it looks like a channel slug.
        via: body.via,
        refs: (body.refs ?? [])
          .filter((r) => r?.id)
          .map((r) => ({ kind: (r.kind ?? "intent") as "intent", id: String(r.id) })),
      });
      return jsonBig(c, { message, mode: runtime.mode });
    } catch (err) {
      return jsonBig(c, { error: err instanceof Error ? err.message : "post_failed" }, 400);
    }
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

  app.get("/usage", async (c) => {
    // Raw operation counts by audit-event type for a period (?since=ISO, or
    // the current UTC month). The cloud folds these into billing meters;
    // billing semantics deliberately do not live in this package. `complete`
    // says whether the full persisted trail answered or only the bounded
    // in-memory ring — a partial count served as a total is a billing lie.
    const since = c.req.query("since") || undefined;
    if (since && Number.isNaN(Date.parse(since))) {
      return jsonBig(c, { error: "invalid_since" }, 400);
    }
    const usage = await runtime.usage(since);
    return jsonBig(c, { ...usage, mode: runtime.mode });
  });

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

  /**
   * Batch receipt reads: `buyers` is a comma-separated address list, answered
   * with a per-buyer map plus `purchased` (true when any buyer holds a
   * receipt). Lets a control plane gate paid-content delivery on "does any
   * agent in this org hold an entitlement?" in one round trip.
   */
  app.get("/marketplace/entitlement", async (c) => {
    const catalogId = c.req.query("catalogId");
    if (!catalogId) return jsonBig(c, { error: "catalogId_required" }, 400);
    const buyers = (c.req.query("buyers") ?? "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    if (buyers.length === 0) return jsonBig(c, { error: "buyers_required" }, 400);
    if (buyers.length > 100) return jsonBig(c, { error: "too_many_buyers" }, 400);
    if (!buyers.every((b) => /^0x[0-9a-fA-F]{40}$/.test(b))) {
      return jsonBig(c, { error: "buyers_must_be_addresses" }, 400);
    }
    const result = await runtime.marketplaceEntitlements(
      catalogId,
      buyers as `0x${string}`[],
    );
    return jsonBig(c, { catalogId, ...result, mode: runtime.mode, chainId: runtime.chainId });
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

  /**
   * Withdraw this runtime's own accrued seller balance. No payee input: the
   * contract pays `msg.sender`, so accepting one would only misdescribe where
   * the money can go.
   */
  app.post("/marketplace/withdraw", async (c) => {
    try {
      const result = await runtime.marketplaceWithdraw();
      return jsonBig(c, { ...result, mode: runtime.mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : "withdraw_failed";
      const status =
        message === "marketplace_requires_chain" ? 409 : message === "nothing_owed" ? 409 : 400;
      return jsonBig(c, { error: message }, status);
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
      /** Asset stack to fund (symbol or token); omit for the primary (USDC) stack. */
      asset?: string;
    }>(c);
    if (!body.account || body.amount === undefined || body.amount === "") {
      return jsonBig(c, { error: "account_and_amount_required" }, 400);
    }
    const amount = BigInt(body.amount);
    try {
      const result = await runtime.proposeSetGrant({
        account: body.account,
        amount,
        tier: body.tier,
        asset: body.asset,
      });
      return jsonBig(c, {
        ...result,
        mode: runtime.mode,
        amount: amount.toString(),
        asset: body.asset,
      });
    } catch (err) {
      // The asset selector is operator input — an unknown asset (or a
      // non-primary asset in mock mode, which cannot resolve a stack) is a 400,
      // not the generic 500 the primary path keeps for chain/config failures.
      if (body.asset) {
        return jsonBig(
          c,
          { error: err instanceof Error ? err.message : "propose_failed" },
          400,
        );
      }
      throw err;
    }
  });

  app.post("/governance/propose-set-grants", async (c) => {
    // Batch grant change in one proposal — the cadence-rescale path. Entries
    // carry base-unit amount strings; amount 0 clears that node's grant.
    const body = await bodyOf<{
      entries?: Array<{ account?: `0x${string}`; amount?: string | number }>;
      tier?: "low" | "high";
      asset?: string;
    }>(c);
    const raw = body.entries ?? [];
    if (raw.length === 0) {
      return jsonBig(c, { error: "entries_required" }, 400);
    }
    if (raw.some((e) => !e.account || e.amount === undefined || e.amount === "")) {
      return jsonBig(c, { error: "each_entry_needs_account_and_amount" }, 400);
    }
    const entries = raw.map((e) => ({ account: e.account!, amount: BigInt(e.amount!) }));
    try {
      const result = await runtime.proposeSetGrants({ entries, tier: body.tier, asset: body.asset });
      return jsonBig(c, { ...result, mode: runtime.mode, asset: body.asset });
    } catch (err) {
      if (body.asset) {
        return jsonBig(c, { error: err instanceof Error ? err.message : "propose_failed" }, 400);
      }
      throw err;
    }
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

  app.post("/governance/propose-node-stack", async (c) => {
    // Deploy a node's desired stack (fresh rate/window modules with the given
    // params, shared whitelist/spend-cap) and propose binding it — the route
    // that makes a custom rate limit or time window a governance amendment
    // rather than a workspace annotation. Deploys are inert until governance
    // executes the bind, so this holds no authority the chain doesn't check.
    const body = await bodyOf<{
      node?: string;
      modules?: Array<Record<string, unknown>>;
      tier?: "low" | "high";
      asset?: string;
    }>(c);
    if (!body.node || !/^0x[0-9a-fA-F]{40}$/.test(body.node)) {
      return jsonBig(c, { error: "node_required" }, 400);
    }
    if (!Array.isArray(body.modules) || body.modules.length === 0 || body.modules.length > 8) {
      return jsonBig(c, { error: "modules_required" }, 400);
    }
    const specs: NodeStackModuleSpec[] = [];
    for (const m of body.modules) {
      if (m.kind === "whitelist" || m.kind === "spend_cap") {
        specs.push({ kind: m.kind });
      } else if (m.kind === "rate_limit") {
        const maxActions = Number(m.maxActions);
        const windowSeconds = Number(m.windowSeconds);
        if (
          !Number.isInteger(maxActions) ||
          maxActions < 1 ||
          maxActions > 1_000_000 ||
          !Number.isInteger(windowSeconds) ||
          windowSeconds < 1 ||
          windowSeconds > 7 * 86_400
        ) {
          return jsonBig(c, { error: "invalid_rate_limit_params" }, 400);
        }
        specs.push({ kind: "rate_limit", maxActions, windowSeconds });
      } else if (m.kind === "time_window") {
        const start = Number(m.startSecondOfDay);
        const end = Number(m.endSecondOfDay);
        // Mirrors TimeWindowPolicy's constructor guard (end > start, end ≤ 1 day)
        // so a bad window is refused here instead of as a deploy revert.
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end <= start ||
          end > 86_400
        ) {
          return jsonBig(c, { error: "invalid_time_window_params" }, 400);
        }
        specs.push({ kind: "time_window", startSecondOfDay: start, endSecondOfDay: end });
      } else {
        return jsonBig(c, { error: "unknown_module_kind" }, 400);
      }
    }
    try {
      const result = await runtime.proposeNodePolicyStack({
        node: body.node as `0x${string}`,
        modules: specs,
        tier: body.tier,
        asset: body.asset || undefined,
      });
      return jsonBig(c, { ...result, asset: body.asset || undefined, mode: runtime.mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : "propose_node_stack_failed";
      // No chain → 409 (nothing can be deployed honestly); anything else on
      // this route traces to input or wiring the caller can see.
      return jsonBig(c, { error: message }, message === "policy_deploy_requires_chain" ? 409 : 400);
    }
  });

  app.post("/governance/propose-set-whitelist", async (c) => {
    const body = await bodyOf<{
      target?: `0x${string}`;
      allowed?: boolean;
      tier?: "low" | "high";
      asset?: string;
    }>(c);
    if (!body.target || typeof body.allowed !== "boolean") {
      return jsonBig(c, { error: "target_and_allowed_required" }, 400);
    }
    try {
      const result = await runtime.proposeSetWhitelist({
        target: body.target,
        allowed: body.allowed,
        tier: body.tier,
        asset: body.asset || undefined,
      });
      return jsonBig(c, { ...result, asset: body.asset || undefined, mode: runtime.mode });
    } catch (err) {
      // A failing asset selector is operator input, like the agent-cap route.
      if (body.asset) {
        return jsonBig(
          c,
          { error: err instanceof Error ? err.message : "propose_set_whitelist_failed" },
          400,
        );
      }
      throw err;
    }
  });

  app.post("/governance/propose-set-agent-cap", async (c) => {
    const body = await bodyOf<{
      agent?: `0x${string}`;
      cap?: string | number;
      tier?: "low" | "high";
      asset?: string;
    }>(c);
    if (!body.agent || body.cap === undefined || body.cap === "") {
      return jsonBig(c, { error: "agent_and_cap_required" }, 400);
    }
    const cap = BigInt(body.cap);
    try {
      const result = await runtime.proposeSetAgentCap({
        agent: body.agent,
        cap,
        tier: body.tier,
        asset: body.asset || undefined,
      });
      return jsonBig(c, {
        ...result,
        mode: runtime.mode,
        cap: cap.toString(),
        asset: body.asset || undefined,
      });
    } catch (err) {
      // The asset selector is operator input — an unknown asset is a 400,
      // not the generic 500 the primary path keeps for chain/config failures.
      if (body.asset) {
        return jsonBig(
          c,
          { error: err instanceof Error ? err.message : "propose_failed" },
          400,
        );
      }
      throw err;
    }
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

  app.get("/treasury/balances", async (c) => {
    // Real per-asset holdings read from each Treasury; [] in mock mode, so the
    // cloud can replace its demo holdings book with figures the chain holds.
    const balances = await runtime.getTreasuryBalances();
    return jsonBig(c, { balances, mode: runtime.mode });
  });

  app.get("/agents/balances", async (c) => {
    // What each node's own account holds — native float and one row per ERC-20
    // in the address book — grouped by chain. Distinct from allowances: this is
    // the balance in the account, not what the Treasury has reserved for it.
    // [] in mock mode; an empty list means no chain answered, not empty wallets.
    const chains = await runtime.getAgentWallets();
    return jsonBig(c, { chains, mode: runtime.mode });
  });

  /**
   * The chains and tokens agent balances are read on. The cloud pushes this on
   * a settings change; a self-hoster sets WALLET_WATCHLIST instead. RPC URLs
   * are echoed back with their credentials masked — an operator needs to see
   * *which* endpoint is configured, never the key inside it.
   */
  app.get("/wallets/watchlist", (c) =>
    jsonBig(c, {
      watchlist: runtime.getWatchlist().map((w) => ({
        ...w,
        ...(w.rpcUrl ? { rpcUrl: maskRpcUrl(w.rpcUrl) } : {}),
      })),
      mode: runtime.mode,
    }),
  );

  app.post("/wallets/watchlist", async (c) => {
    const body = await bodyOf<{ watchlist?: unknown }>(c);
    const parsed = parseWatchlist(body.watchlist);
    if (!parsed.ok) return jsonBig(c, { error: parsed.error }, 400);
    runtime.setWatchlist(parsed.value);
    return jsonBig(c, { watchlist: parsed.value.length, mode: runtime.mode });
  });

  /**
   * An ERC-20's own symbol and decimals, read from the chain.
   *
   * The check before an operator saves a hand-entered token. A wrong decimals
   * renders a balance with the point in the wrong place; a wrong address reads
   * zero rather than erroring. Neither fails loudly, so the contract is asked
   * directly and 404 means "this address did not answer as an ERC-20 here" —
   * a refusal to guess, not a failed request.
   */
  app.get("/wallets/token", async (c) => {
    const chainId = Number(c.req.query("chainId"));
    const address = c.req.query("address") ?? "";
    if (!Number.isInteger(chainId) || chainId <= 0) {
      return jsonBig(c, { error: "invalid_chain_id" }, 400);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return jsonBig(c, { error: "invalid_address" }, 400);
    }
    const found = await runtime.readWatchedToken(chainId, address as `0x${string}`);
    if (!found.ok) {
      // 404 = the chain answered and this is not a token. 503 = we could not
      // ask. Collapsing them would tell an operator to fix a correct address
      // because a shared endpoint happened to throttle.
      return jsonBig(
        c,
        { error: found.reason, detail: found.detail },
        found.reason === "not_erc20" ? 404 : 503,
      );
    }
    return jsonBig(c, {
      symbol: found.symbol,
      decimals: found.decimals,
      chainId,
      address,
      mode: runtime.mode,
    });
  });

  app.get("/assets", async (c) => {
    // The asset stacks this org can budget in (primary first). Drives the
    // cloud's grant/cap asset picker; [] in mock mode — the list is read from
    // the deployment's address book, never invented.
    return jsonBig(c, { assets: runtime.listAssets(), mode: runtime.mode });
  });

  app.get("/policies", async (c) => {
    // Per-node policy-stack composition (the module EscalationRouter binds per
    // node, plus each module's kind and enforced params) read from the chain —
    // what the cloud shows as a node's real stack instead of "unknown".
    // [] in mock mode; ?asset=SYMBOL|token selects a stack, ?node=0x… one node.
    const asset = c.req.query("asset") || undefined;
    const node = c.req.query("node") || undefined;
    if (node && !/^0x[0-9a-fA-F]{40}$/.test(node)) {
      return jsonBig(c, { error: "invalid_node" }, 400);
    }
    try {
      const policies = await runtime.getNodePolicies({
        asset,
        node: node as `0x${string}` | undefined,
      });
      return jsonBig(c, { policies, asset, mode: runtime.mode });
    } catch (err) {
      // A failing selector is operator input; a bare read failure is not.
      if (asset || node) {
        return jsonBig(
          c,
          { error: err instanceof Error ? err.message : "policies_read_failed" },
          400,
        );
      }
      throw err;
    }
  });

  app.get("/governance/grants", async (c) => {
    // Configured per-epoch grants for an asset's EpochStreamer — the current
    // budget the cloud reads to rescale when the workspace cadence changes.
    // Optional ?asset=SYMBOL|token; omit for the primary (USDC) stack.
    const asset = c.req.query("asset") || undefined;
    try {
      const grants = await runtime.getGrants(asset);
      return jsonBig(c, { grants, asset, mode: runtime.mode });
    } catch (err) {
      return jsonBig(
        c,
        { error: err instanceof Error ? err.message : "grants_read_failed" },
        400,
      );
    }
  });

  app.get("/epoch", async (c) => {
    const q = queue.status();
    // Optional ?asset=SYMBOL|token reads that asset's own EpochStreamer.
    const asset = c.req.query("asset") || undefined;
    try {
      const currentEpoch = await runtime.getCurrentEpoch(asset);
      return jsonBig(c, {
        currentEpoch,
        asset,
        mode: runtime.mode,
        chainId: runtime.chainId,
        schedule: q.epochSchedule ?? null,
        queue: q.provider,
      });
    } catch (err) {
      if (asset) {
        return jsonBig(
          c,
          { error: err instanceof Error ? err.message : "epoch_read_failed" },
          400,
        );
      }
      throw err;
    }
  });

  app.post("/epoch", async (c) => {
    // Optional { asset } streams that asset's own EpochStreamer; omit for USDC.
    const body = await bodyOf<{ asset?: string }>(c);
    // Epoch-triggered flows fire even when the onchain stream can't run
    // (mock mode) — the automation layer stays testable everywhere.
    let result: Record<string, unknown> = {};
    let epochError: string | undefined;
    try {
      result = (await runtime.runEpoch(body.asset)) as unknown as Record<string, unknown>;
    } catch (err) {
      epochError = err instanceof Error ? err.message : "epoch_failed";
    }
    const epochRuns = await flows.runTriggered("epoch");
    return jsonBig(
      c,
      {
        ...result,
        ...(body.asset ? { asset: body.asset } : {}),
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

  app.post("/epoch/schedule", async (c) => {
    // Reschedule the recurring epoch at runtime. The cadence is a workspace
    // setting owned by the cloud; it pushes the chosen cron here, and the
    // durable queue persists it so the schedule survives restart.
    const body = await bodyOf<{ cron?: string }>(c);
    const cron =
      typeof body.cron === "string" ? body.cron.trim().replace(/\s+/g, " ") : "";
    if (!isValidCron(cron)) {
      return jsonBig(
        c,
        { error: "invalid_cron", detail: "Expected a 5-field cron expression." },
        400,
      );
    }
    try {
      await queue.scheduleEpoch(cron);
    } catch (err) {
      return jsonBig(
        c,
        { error: err instanceof Error ? err.message : "reschedule_failed" },
        400,
      );
    }
    const q = queue.status();
    return jsonBig(c, {
      schedule: q.epochSchedule ?? null,
      queue: q.provider,
      mode: runtime.mode,
    });
  });

  return app;
}

/**
 * The app served when no chain could be reached.
 *
 * It exists so the process still listens: a connection refused tells a caller
 * nothing, and the cloud cannot distinguish "orchestrator down" from "chain
 * misconfigured" without being told which. `/health` answers 200 with the
 * reason; every data route answers 503.
 *
 * Never `[]`. An empty array is a claim about the organisation — that it has no
 * agents, no intents, no history. 503 is a claim about this process. Collapsing
 * the two is what let a misconfigured orchestrator render as an empty workspace.
 */
export function createUnavailableApp(options: {
  reason: string;
  detail: string;
  isDbReady: () => boolean;
  isDbConfigured: () => boolean;
  authToken?: string;
}): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.newResponse(null, 204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
      });
    }
    if (options.authToken && !(c.req.method === "GET" && c.req.path === "/health")) {
      if (!isAuthorized(c.req.header("authorization"), options.authToken)) {
        return jsonBig(c, { error: "unauthorized" }, 401);
      }
    }
    await next();
  });

  app.get("/health", (c) =>
    jsonBig(c, {
      // `ok` describes the process, which is running and answering. Whether it
      // can reach a chain is a separate question, answered separately.
      ok: true,
      service: "lacrew-orchestrator",
      mode: "unavailable",
      chainId: null,
      chain: { reachable: false, reason: options.reason, detail: options.detail },
      db: { configured: options.isDbConfigured(), ready: options.isDbReady() },
    }),
  );

  app.all("*", (c) =>
    jsonBig(c, { error: "chain_unavailable", reason: options.reason, detail: options.detail }, 503),
  );

  return app;
}

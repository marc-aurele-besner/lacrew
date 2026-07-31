/**
 * External MCP servers — someone else's tools, behind an allowlist (PRD F2.30).
 *
 * A connector is an HTTP surface the operator wrote down route by route. MCP is
 * the ecosystem's own answer to the same problem, and operators already run
 * servers for GitHub, a browser, a database, their own internal API. Attaching
 * one is *composition*: LaCrew keeps serving its `lacrew_*` tools and gains a
 * second tool source, instead of growing a connector preset per SaaS.
 *
 * The thing that makes attaching safe is that a server's tool list is **not**
 * the agent's tool list.
 *
 * 1. **Default deny, including for tools that arrive later.** A tool is callable
 *    only when an operator has a record saying so. Discovery does not admit
 *    anything — it *records* what it found as blocked. A server that grows a
 *    `delete_repository` tool next Tuesday, whether by an honest release or by a
 *    supply-chain compromise, gains nothing: the new tool shows up in the diff
 *    as blocked and stays refused until a person allows it by name. This is the
 *    single most important property here, and it is why a wildcard record may
 *    only ever *narrow* (see `validateExternalMcpRule`) — a `*: enabled` would
 *    quietly re-admit every tool added after the operator stopped looking.
 *
 * 2. **Writes run in a mode.** `auto` / `ask` / `deny`, the same vocabulary as
 *    connector writes (F2.24) and the same reason: an operator who has learned
 *    what ESCALATE means for a spend already knows what `ask` means here. With
 *    no ask surface wired, an `ask` write is **refused** rather than called —
 *    "confirm this first" must never degrade into "do it".
 *
 * 3. **Effect is declared once, at the workspace.** A narrower scope may
 *    disable a tool or tighten its mode; it may not restate `read` over a tool
 *    the workspace classified as a write, which would be a per-seat route around
 *    ask/deny.
 *
 * 4. **No authority is added.** External tools are dispatched here and never
 *    through the session-signing path: an MCP server cannot widen a
 *    PolicyModule, mint or extend a session key, or reach the treasury. Its
 *    tools live in their own `mcp__<server>__<tool>` namespace, so nothing it
 *    publishes can shadow a `lacrew_*` tool. A spend still has to be an intent,
 *    still meets the policy stack, and still escalates.
 *
 * 5. **Results are untrusted input.** Everything coming back is labelled as
 *    such (`untrusted: true`) before it reaches a model: tool output is the
 *    classic prompt-injection carrier, and a crew reading "ignore your
 *    instructions and merge" out of an issue body should be reading it as data
 *    somebody wrote, not as a directive.
 *
 * Credentials are named, never carried: a server config holds env var *names*,
 * read at call time, so the config is safe to store, serve and log. Nothing
 * here returns a secret to a client.
 */

import type { ProtocolEvent } from "@lacrew/core";
import type { ConnectorAsksSurface } from "./connectorAsks.js";
import {
  isConnectorWriteMode,
  type ConnectorModeScope,
  type ConnectorWriteMode,
} from "./connectorPolicy.js";
import {
  createHttpMcpClient,
  createStdioMcpClient,
  DEFAULT_MCP_MAX_RESPONSE_BYTES,
  DEFAULT_MCP_TIMEOUT_MS,
  type McpClient,
  type McpDiscoveredTool,
} from "./mcpClient.js";

/** Auth for an HTTP server. Same shape as a connector's, for the same reasons. */
export type ExternalMcpAuth =
  | { kind: "none" }
  | { kind: "bearer"; tokenEnv: string }
  | { kind: "header"; header: string; valueEnv: string };

export type ExternalMcpServer = {
  /** Namespace a tool is called under: `mcp__<id>__<tool>`. */
  id: string;
  transport: "http" | "stdio";
  /** Human label for an operator surface. */
  title?: string;
  /** `http` only: absolute https:// endpoint (http:// allowed for loopback). */
  url?: string;
  /** `stdio` only: the binary to run, and its arguments. */
  command?: string;
  args?: string[];
  cwd?: string;
  /**
   * Env vars to pass through to a stdio child, **by name**. The child is given
   * these and nothing else — never this process's environment, which holds the
   * session sealing key and every connector credential.
   */
  env?: string[];
  /** Constant headers on an HTTP server; may not carry auth material. */
  headers?: Record<string, string>;
  auth?: ExternalMcpAuth;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

/** Where a tool rule applies — the org-chart scoping connectors already use. */
export type ExternalMcpScope = ConnectorModeScope;

export type ExternalMcpToolRule = {
  scope: ExternalMcpScope;
  server: string;
  /** A tool name, or `*` for every tool on the server (narrowing only). */
  tool: string;
  /** The allowlist bit. False is the state every tool starts in. */
  enabled: boolean;
  /**
   * Whether calling it changes anything on the other side. Workspace scope
   * only — see the note on effect above. Unset reads as `write`, because a tool
   * nobody has classified is the one to be careful with.
   */
  effect?: "read" | "write";
  /** Write mode; meaningless on a read and refused there. */
  mode?: ConnectorWriteMode;
  /** The server's own description, kept for the operator surface. */
  description?: string;
};

export type ExternalMcpToolRecord = ExternalMcpToolRule & {
  at: string;
  /** When discovery last saw this tool on the server. Absent = never seen. */
  discoveredAt?: string;
};

/** Bounded, durable set of tool records. */
export interface ExternalMcpStore {
  loadExternalMcpTools(): Promise<ExternalMcpToolRecord[]>;
  saveExternalMcpTool(record: ExternalMcpToolRecord): Promise<void>;
  removeExternalMcpTool(scopeKey: string, server: string, tool: string): Promise<void>;
}

export type ExternalMcpCallContext = {
  principal?: string;
  managers?: Iterable<string>;
  flowId?: string;
  runId?: string;
  threadId?: string;
};

export type ExternalMcpCallResult = {
  server: string;
  tool: string;
  /**
   * Always true. Tool output is attacker-reachable text — an issue body, a web
   * page, a row someone else wrote — and the flag travels with it so a model
   * step reads it as data rather than as instructions.
   */
  untrusted: true;
  content: unknown;
  isError: boolean;
  ms: number;
};

export type ExternalMcpToolResolution = {
  /** Whether an operator has any record for this tool. False = never seen. */
  known: boolean;
  enabled: boolean;
  effect: "read" | "write";
  mode: ConnectorWriteMode;
  /** What decided it, so an inherited value is legible in a UI. */
  source:
    | { kind: "default-deny" }
    | { kind: "rule"; scope: ExternalMcpScope; tool: string };
};

/** A tool as it is safe to publish: policy and shape, never a credential. */
export type ExternalMcpToolView = {
  name: string;
  description?: string;
  enabled: boolean;
  effect: "read" | "write";
  mode: ConnectorWriteMode;
  /** How `enabled`/`mode` were decided for the subject `describe()` was asked about. */
  source: ExternalMcpToolResolution["source"];
  /** Present on the server's current tool list. False = recorded but gone. */
  present: boolean;
  discoveredAt?: string;
};

export type ExternalMcpServerView = {
  id: string;
  title?: string;
  transport: "http" | "stdio";
  /** The endpoint, or the command line. Neither is secret; both are decisions. */
  endpoint: string;
  timeoutMs: number;
  maxResponseBytes: number;
  auth: {
    kind: ExternalMcpAuth["kind"];
    /** Env vars this server reads — names only, never values. */
    envVars: string[];
    ready: boolean;
  };
  tools: ExternalMcpToolView[];
  /** Tools discovered but never recorded by an operator: blocked right now. */
  blockedCount: number;
  lastRefreshAt?: string;
  lastRefreshError?: string;
};

export type ExternalMcpRefreshResult = {
  server: string;
  ok: boolean;
  /** Tools seen for the first time. Recorded as disabled, never callable yet. */
  added: string[];
  /** Tools with a record that the server no longer offers. */
  removed: string[];
  unchanged: string[];
  error?: string;
};

export type ExternalMcpRegistry = {
  list(): ExternalMcpServer[];
  /** Tool names this subject may actually call, as `mcp__<server>__<tool>`. */
  toolNames(subject?: ExternalMcpCallContext): string[];
  /** Whether `name` names a tool on a registered server (allowlisted or not). */
  handles(name: string): boolean;
  call(
    name: string,
    args: Record<string, unknown>,
    ctx?: ExternalMcpCallContext,
  ): Promise<ExternalMcpCallResult>;
  describe(subject?: ExternalMcpCallContext): ExternalMcpServerView[];
  resolve(
    server: string,
    tool: string,
    subject?: ExternalMcpCallContext,
  ): ExternalMcpToolResolution;
  /** Re-read tool lists; new tools are recorded blocked. Omit id for all servers. */
  refresh(serverId?: string): Promise<ExternalMcpRefreshResult[]>;
  /** Reachability check for a setup drawer: does it answer, and with how many tools. */
  ping(serverId: string): Promise<{ server: string; ok: boolean; ms: number; tools?: number; error?: string }>;
  rules(): ExternalMcpToolRecord[];
  setTool(rule: ExternalMcpToolRule): Promise<ExternalMcpToolRecord>;
  clearTool(scope: ExternalMcpScope, server: string, tool: string): Promise<boolean>;
  hydrate(): Promise<number>;
  close(): Promise<void>;
};

export type ExternalMcpRegistryOptions = {
  servers: ExternalMcpServer[];
  store?: ExternalMcpStore;
  /** Environment credentials are read from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Transport factory; defaults to the http/stdio adapters. Injected in tests. */
  clientFor?: (server: ExternalMcpServer) => McpClient;
  onEvent?: (event: ProtocolEvent) => void;
  /**
   * Ask-mode confirmations (F2.24). Absent, an `ask` write is refused rather
   * than called: a registry with nowhere to put the question cannot answer it.
   */
  asks?: Pick<ConnectorAsksSurface, "gate">;
  /**
   * Record argument *keys* on the audit row (`LACREW_MCP_AUDIT_ARGS=1`). Values
   * are never recorded under any setting — an argument routinely carries a
   * customer name or a private repo, and the trail is not the place for one.
   */
  auditArgKeys?: boolean;
  now?: () => Date;
};

const norm = (value: string): string => value.trim().toLowerCase();

export function externalMcpScopeKey(scope: ExternalMcpScope): string {
  return scope.level === "workspace" ? "workspace" : `${scope.level}:${norm(scope.ref)}`;
}

/**
 * The tool name a flow calls.
 *
 * `mcp__` prefixed and double-underscore separated so an external tool can
 * never be mistaken for — or shadow — a `lacrew_*` tool or a `<connector>.<route>`.
 * A server id may not contain `__`, which is what keeps the split unambiguous
 * for tool names that do.
 */
export function externalToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function parseExternalToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  const server = rest.slice(0, split);
  const tool = rest.slice(split + 2);
  return server && tool ? { server, tool } : null;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

export function externalMcpEnvVars(server: ExternalMcpServer): string[] {
  const auth = server.auth ?? { kind: "none" as const };
  const authVars =
    auth.kind === "bearer" ? [auth.tokenEnv] : auth.kind === "header" ? [auth.valueEnv] : [];
  return [...authVars, ...(server.env ?? [])];
}

/**
 * Reject a server config the operator got wrong at registration, rather than at
 * the first call inside a funded run.
 */
export function validateExternalMcpServer(server: ExternalMcpServer): string[] {
  const errors: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(server.id ?? "")) {
    errors.push(`mcp server id "${server.id}" must be lowercase letters, digits, or dashes`);
  }
  if (server.transport !== "http" && server.transport !== "stdio") {
    errors.push(`mcp server "${server.id}" needs transport http | stdio`);
  }
  if (server.transport === "http") {
    let url: URL | undefined;
    try {
      url = new URL(server.url ?? "");
    } catch {
      errors.push(`mcp server "${server.id}" url is not a URL`);
    }
    if (url && url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
      errors.push(`mcp server "${server.id}" url must be https (http is allowed only for loopback)`);
    }
    if (server.command) {
      errors.push(`mcp server "${server.id}" is http and cannot carry a command`);
    }
  }
  if (server.transport === "stdio") {
    if (!server.command?.trim()) errors.push(`mcp server "${server.id}" needs a command`);
    if (server.url) errors.push(`mcp server "${server.id}" is stdio and cannot carry a url`);
  }
  if (server.auth?.kind === "bearer" && !server.auth.tokenEnv?.trim()) {
    errors.push(`mcp server "${server.id}" bearer auth needs tokenEnv`);
  }
  if (server.auth?.kind === "header") {
    if (!server.auth.header?.trim()) errors.push(`mcp server "${server.id}" needs a header name`);
    if (!server.auth.valueEnv?.trim()) errors.push(`mcp server "${server.id}" needs valueEnv`);
  }
  const authHeaderName =
    server.auth?.kind === "bearer"
      ? "authorization"
      : server.auth?.kind === "header"
        ? server.auth.header?.trim().toLowerCase()
        : undefined;
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      errors.push(`mcp server "${server.id}" header "${name}" is not a header name`);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`mcp server "${server.id}" header "${name}" has no value`);
    }
    // A constant header able to set credentials would be a second, unaudited
    // way to authenticate, and one an operator reads as harmless metadata.
    if (name.toLowerCase() === "authorization" || name.toLowerCase() === authHeaderName) {
      errors.push(`mcp server "${server.id}" header "${name}" would override the credential`);
    }
  }
  for (const name of server.env ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`mcp server "${server.id}" env "${name}" is not an environment variable name`);
    }
  }
  return errors;
}

/**
 * Reject a tool rule that would break the two invariants above: a wildcard that
 * admits, or a narrow scope that reclassifies a write as a read.
 */
export function validateExternalMcpRule(rule: ExternalMcpToolRule): string[] {
  const errors: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(rule.server ?? "")) {
    errors.push(`rule server "${rule.server}" is not a server id`);
  }
  if (!rule.tool?.trim()) errors.push("rule needs a tool name or *");
  if (rule.tool === "*" && rule.enabled) {
    // The whole feature's safety rests on a tool arriving disabled. A wildcard
    // enable would admit every tool the server adds after this rule was written.
    errors.push(`rule "${rule.server}.*" cannot enable: a wildcard may only narrow`);
  }
  if (rule.effect !== undefined && rule.effect !== "read" && rule.effect !== "write") {
    errors.push(`rule "${rule.server}.${rule.tool}" effect must be read | write`);
  }
  if (rule.effect !== undefined && rule.scope.level !== "workspace") {
    errors.push(
      `rule "${rule.server}.${rule.tool}" may only set effect at workspace scope: a narrower ` +
        "scope calling a write a read would be a per-seat route around ask/deny",
    );
  }
  if (rule.mode !== undefined && !isConnectorWriteMode(rule.mode)) {
    errors.push(`rule "${rule.server}.${rule.tool}" mode must be auto | ask | deny`);
  }
  if (rule.mode && rule.effect === "read") {
    // Same reasoning connectors use: a confirmation that gates nothing teaches
    // operators to click through the ones that do.
    errors.push(`rule "${rule.server}.${rule.tool}" is a read and cannot carry a mode`);
  }
  return errors;
}

const DENIED: ExternalMcpToolResolution = {
  known: false,
  enabled: false,
  effect: "write",
  mode: "deny",
  source: { kind: "default-deny" },
};

/**
 * What a tool does for one caller: is it admitted, is it a write, and in which
 * mode.
 *
 * Precedence is narrowest-first — agent, then the nearest crew, then the
 * workspace — and an exact tool name beats a `*` at the same level, exactly as
 * connector write rules resolve. `effect` is the exception and is read only
 * from the workspace record, so classifying a tool is a single decision rather
 * than one per seat.
 *
 * No matching record at all is a refusal, not a default: that is the shape of
 * "disabled until explicitly allowed".
 */
export function resolveExternalTool(
  server: string,
  tool: string,
  records: readonly ExternalMcpToolRecord[],
  subject: ExternalMcpCallContext = {},
): ExternalMcpToolResolution {
  const serverId = norm(server);
  const matching = records.filter(
    (r) => norm(r.server) === serverId && (r.tool === tool || r.tool === "*"),
  );
  if (matching.length === 0) return DENIED;

  const byScope = new Map<string, ExternalMcpToolRecord[]>();
  for (const record of matching) {
    const key = externalMcpScopeKey(record.scope);
    const bucket = byScope.get(key);
    if (bucket) bucket.push(record);
    else byScope.set(key, [record]);
  }

  const pick = (key: string): ExternalMcpToolRecord | undefined => {
    const bucket = byScope.get(key);
    if (!bucket) return undefined;
    // Last writer wins within a scope, and an exact name beats the wildcard.
    return [...bucket].reverse().find((r) => r.tool === tool) ?? [...bucket].reverse()[0];
  };

  const registration = byScope
    .get("workspace")
    ?.filter((r) => r.tool === tool)
    .at(-1);
  const effect = registration?.effect ?? "write";

  const order: string[] = [];
  const principal = subject.principal ? norm(subject.principal) : undefined;
  if (principal) order.push(`agent:${principal}`, `crew:${principal}`);
  for (const manager of subject.managers ?? []) order.push(`crew:${norm(manager)}`);
  order.push("workspace");

  for (const key of order) {
    const hit = pick(key);
    if (!hit) continue;
    return {
      known: true,
      enabled: hit.enabled,
      effect,
      // A read carries no mode; a write with none declared runs at `auto`, the
      // same default a connector route has.
      mode: effect === "read" ? "auto" : (hit.mode ?? registration?.mode ?? "auto"),
      source: { kind: "rule", scope: hit.scope, tool: hit.tool },
    };
  }
  return DENIED;
}

/** Build the transport for a server, reading credentials by name at call time. */
function defaultClientFor(
  server: ExternalMcpServer,
  env: Record<string, string | undefined>,
): McpClient {
  const timeoutMs = server.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const maxResponseBytes = server.maxResponseBytes ?? DEFAULT_MCP_MAX_RESPONSE_BYTES;
  if (server.transport === "stdio") {
    const passthrough: Record<string, string> = {};
    for (const name of server.env ?? []) {
      const value = env[name];
      if (value !== undefined) passthrough[name] = value;
    }
    return createStdioMcpClient({
      serverId: server.id,
      command: server.command ?? "",
      args: server.args ?? [],
      env: passthrough,
      ...(server.cwd ? { cwd: server.cwd } : {}),
      timeoutMs,
      maxResponseBytes,
    });
  }
  return createHttpMcpClient({
    serverId: server.id,
    url: server.url ?? "",
    ...(server.headers ? { headers: server.headers } : {}),
    authHeader: () => {
      const auth = server.auth ?? { kind: "none" as const };
      if (auth.kind === "bearer") {
        const token = env[auth.tokenEnv]?.trim();
        if (!token) throw new Error(`mcp_missing_credential:${auth.tokenEnv}`);
        return { authorization: `Bearer ${token}` };
      }
      if (auth.kind === "header") {
        const value = env[auth.valueEnv]?.trim();
        if (!value) throw new Error(`mcp_missing_credential:${auth.valueEnv}`);
        return { [auth.header.toLowerCase()]: value };
      }
      return {};
    },
    timeoutMs,
    maxResponseBytes,
  });
}

export function createExternalMcpRegistry(
  opts: ExternalMcpRegistryOptions,
): ExternalMcpRegistry {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const byId = new Map<string, ExternalMcpServer>();
  for (const server of opts.servers) {
    const errors = validateExternalMcpServer(server);
    if (errors.length > 0) throw new Error(`invalid_mcp_server: ${errors.join("; ")}`);
    byId.set(server.id, server);
  }

  const clients = new Map<string, McpClient>();
  const clientOf = (server: ExternalMcpServer): McpClient => {
    const existing = clients.get(server.id);
    if (existing) return existing;
    const client = opts.clientFor?.(server) ?? defaultClientFor(server, env);
    clients.set(server.id, client);
    return client;
  };

  const records = new Map<string, ExternalMcpToolRecord>();
  const recordKey = (scope: ExternalMcpScope, server: string, tool: string): string =>
    `${externalMcpScopeKey(scope)}|${norm(server)}|${tool}`;
  /** Last discovery per server: what the server offers, and how it went. */
  const discovery = new Map<
    string,
    { tools: McpDiscoveredTool[]; at: string; error?: string }
  >();

  const audit = (type: ProtocolEvent["type"], payload: Record<string, unknown>): void => {
    opts.onEvent?.({ type, at: now().toISOString(), payload });
  };

  const save = async (record: ExternalMcpToolRecord): Promise<void> => {
    records.set(recordKey(record.scope, record.server, record.tool), record);
    await opts.store?.saveExternalMcpTool(record);
  };

  const refreshOne = async (server: ExternalMcpServer): Promise<ExternalMcpRefreshResult> => {
    const at = now().toISOString();
    let tools: McpDiscoveredTool[];
    try {
      tools = await clientOf(server).listTools();
    } catch (err) {
      const error = err instanceof Error ? err.message : "mcp_refresh_failed";
      discovery.set(server.id, { tools: discovery.get(server.id)?.tools ?? [], at, error });
      // Not a silent skip: an unreadable server leaves the previous allowlist in
      // force, and an operator reading "3 tools enabled" deserves to know the
      // list is stale rather than confirmed.
      audit("ExternalMcpDiscovered", { server: server.id, ok: false, error });
      return { server: server.id, ok: false, added: [], removed: [], unchanged: [], error };
    }
    discovery.set(server.id, { tools, at });

    const known = new Set(
      [...records.values()]
        .filter((r) => norm(r.server) === norm(server.id) && r.tool !== "*")
        .map((r) => r.tool),
    );
    const seen = new Set(tools.map((t) => t.name));
    const added: string[] = [];
    const unchanged: string[] = [];

    for (const tool of tools) {
      const existingKey = recordKey({ level: "workspace" }, server.id, tool.name);
      const existing = records.get(existingKey);
      if (existing) {
        unchanged.push(tool.name);
        await save({
          ...existing,
          ...(tool.description ? { description: tool.description } : {}),
          discoveredAt: at,
        });
        continue;
      }
      if (known.has(tool.name)) {
        // Recorded at a narrower scope only; nothing to register, and enabling
        // it here would widen what somebody deliberately scoped.
        unchanged.push(tool.name);
        continue;
      }
      added.push(tool.name);
      // The whole point: a newly seen tool is written down as **disabled**, and
      // classified `write` unless the server's own annotation says read-only —
      // and even then the operator has to allow it before anything is callable.
      await save({
        scope: { level: "workspace" },
        server: server.id,
        tool: tool.name,
        enabled: false,
        effect: tool.annotations?.readOnlyHint === true ? "read" : "write",
        ...(tool.description ? { description: tool.description } : {}),
        at,
        discoveredAt: at,
      });
    }

    const removed = [...known].filter((tool) => !seen.has(tool));
    audit("ExternalMcpDiscovered", {
      server: server.id,
      ok: true,
      tools: tools.length,
      added: added.length,
      removed: removed.length,
      // Named, not just counted: "3 new tools blocked" is the line an operator
      // acts on, and which three is the part that decides what they do next.
      ...(added.length ? { addedTools: added } : {}),
      ...(removed.length ? { removedTools: removed } : {}),
    });
    return { server: server.id, ok: true, added, removed, unchanged };
  };

  const toolsOf = (
    server: ExternalMcpServer,
    subject: ExternalMcpCallContext,
  ): ExternalMcpToolView[] => {
    const found = discovery.get(server.id);
    const present = new Map((found?.tools ?? []).map((t) => [t.name, t]));
    const names = new Set<string>([
      ...present.keys(),
      ...[...records.values()]
        .filter((r) => norm(r.server) === norm(server.id) && r.tool !== "*")
        .map((r) => r.tool),
    ]);
    return [...names].sort().map((tool) => {
      const resolved = resolveExternalTool(server.id, tool, [...records.values()], subject);
      const record = records.get(recordKey({ level: "workspace" }, server.id, tool));
      const description = present.get(tool)?.description ?? record?.description;
      return {
        name: tool,
        ...(description ? { description } : {}),
        enabled: resolved.enabled,
        effect: resolved.effect,
        mode: resolved.mode,
        source: resolved.source,
        present: present.has(tool),
        ...(record?.discoveredAt ? { discoveredAt: record.discoveredAt } : {}),
      };
    });
  };

  return {
    list: () => [...byId.values()],
    rules: () => [...records.values()],
    resolve: (server, tool, subject) =>
      resolveExternalTool(server, tool, [...records.values()], subject),

    handles: (name) => {
      const parsed = parseExternalToolName(name);
      return parsed !== null && byId.has(parsed.server);
    },

    toolNames: (subject = {}) =>
      [...byId.values()].flatMap((server) =>
        toolsOf(server, subject)
          .filter((tool) => tool.enabled && tool.present)
          .map((tool) => externalToolName(server.id, tool.name)),
      ),

    describe: (subject = {}) =>
      [...byId.values()].map((server) => {
        const envVars = externalMcpEnvVars(server);
        const found = discovery.get(server.id);
        const tools = toolsOf(server, subject);
        return {
          id: server.id,
          ...(server.title ? { title: server.title } : {}),
          transport: server.transport,
          endpoint:
            server.transport === "http"
              ? (server.url ?? "")
              : [server.command, ...(server.args ?? [])].join(" ").trim(),
          timeoutMs: server.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
          maxResponseBytes: server.maxResponseBytes ?? DEFAULT_MCP_MAX_RESPONSE_BYTES,
          auth: {
            kind: (server.auth ?? { kind: "none" as const }).kind,
            envVars,
            // Presence only, exactly as connectors report it: "is my token
            // there?" is answerable without reading it, and a status surface
            // that reads it is an exfiltration route.
            ready: envVars.every((name) => Boolean(env[name]?.trim())),
          },
          tools,
          blockedCount: tools.filter((t) => !t.enabled && t.present).length,
          ...(found?.at ? { lastRefreshAt: found.at } : {}),
          ...(found?.error ? { lastRefreshError: found.error } : {}),
        };
      }),

    setTool: async (rule) => {
      const errors = validateExternalMcpRule(rule);
      if (errors.length > 0) throw new Error(`invalid_mcp_tool_rule: ${errors.join("; ")}`);
      if (!byId.has(rule.server)) throw new Error(`unknown_mcp_server:${rule.server}`);
      const existing = records.get(recordKey(rule.scope, rule.server, rule.tool));
      const record: ExternalMcpToolRecord = {
        ...rule,
        at: now().toISOString(),
        ...(existing?.discoveredAt ? { discoveredAt: existing.discoveredAt } : {}),
        ...(rule.description || existing?.description
          ? { description: rule.description ?? existing?.description }
          : {}),
      };
      await save(record);
      return record;
    },

    clearTool: async (scope, server, tool) => {
      const existed = records.delete(recordKey(scope, server, tool));
      if (existed) {
        await opts.store?.removeExternalMcpTool(externalMcpScopeKey(scope), server, tool);
      }
      return existed;
    },

    refresh: async (serverId) => {
      const targets = serverId
        ? [byId.get(serverId)].filter((s): s is ExternalMcpServer => Boolean(s))
        : [...byId.values()];
      if (serverId && targets.length === 0) throw new Error(`unknown_mcp_server:${serverId}`);
      const results: ExternalMcpRefreshResult[] = [];
      for (const server of targets) results.push(await refreshOne(server));
      return results;
    },

    ping: async (serverId) => {
      const server = byId.get(serverId);
      if (!server) throw new Error(`unknown_mcp_server:${serverId}`);
      const started = Date.now();
      try {
        const tools = await clientOf(server).listTools();
        return { server: serverId, ok: true, ms: Date.now() - started, tools: tools.length };
      } catch (err) {
        return {
          server: serverId,
          ok: false,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : "mcp_unreachable",
        };
      }
    },

    call: async (name, args, ctx = {}) => {
      const parsed = parseExternalToolName(name);
      const server = parsed ? byId.get(parsed.server) : undefined;
      if (!parsed || !server) throw new Error(`unknown_external_mcp_tool:${name}`);
      const { tool } = parsed;

      const policy = resolveExternalTool(server.id, tool, [...records.values()], ctx);
      if (!policy.enabled) {
        // One error for "never seen" and "seen and refused": both mean the
        // operator has not admitted this tool, and the caller's next move is
        // the same. The audit row carries which it was.
        audit("ExternalMcpCalled", {
          server: server.id,
          tool,
          ok: false,
          called: false,
          refusal: policy.known ? "tool_disabled" : "tool_unknown",
          ...(ctx.principal ? { principal: ctx.principal } : {}),
        });
        throw new Error(`tool_not_allowlisted:${server.id}.${tool}`);
      }

      if (policy.effect === "write") {
        if (policy.mode === "deny") {
          audit("ExternalMcpCalled", {
            server: server.id,
            tool,
            effect: policy.effect,
            mode: policy.mode,
            ok: false,
            called: false,
            refusal: "mode_denied",
            ...(ctx.principal ? { principal: ctx.principal } : {}),
          });
          throw new Error(`mcp_mode_denied:${server.id}.${tool}`);
        }
        if (policy.mode === "ask") {
          if (!opts.asks) {
            // FR3: with no pause path, a write that was supposed to be
            // confirmed is refused. Running it as `auto` would turn the
            // operator's "ask me first" into "go ahead" on a wiring gap.
            audit("ExternalMcpCalled", {
              server: server.id,
              tool,
              effect: policy.effect,
              mode: policy.mode,
              ok: false,
              called: false,
              refusal: "ask_unavailable",
              ...(ctx.principal ? { principal: ctx.principal } : {}),
            });
            throw new Error(`mcp_mode_denied:${server.id}.${tool}:ask_unavailable`);
          }
          await opts.asks.gate({
            connector: `mcp:${server.id}`,
            route: tool,
            method: "call",
            path: `${server.id}/${tool}`,
            args,
            ...(ctx.principal ? { principal: ctx.principal } : {}),
            ...(ctx.flowId ? { flowId: ctx.flowId } : {}),
            ...(ctx.runId ? { runId: ctx.runId } : {}),
            ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
          });
        }
      }

      const started = Date.now();
      let result: ExternalMcpCallResult;
      try {
        const raw = await clientOf(server).callTool(tool, args);
        result = {
          server: server.id,
          tool,
          untrusted: true,
          content: raw.content,
          isError: raw.isError,
          ms: Date.now() - started,
        };
      } catch (err) {
        audit("ExternalMcpCalled", {
          server: server.id,
          tool,
          effect: policy.effect,
          ...(policy.effect === "write" ? { mode: policy.mode } : {}),
          ok: false,
          called: true,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : "mcp_call_failed",
          ...(ctx.principal ? { principal: ctx.principal } : {}),
        });
        throw err;
      }

      audit("ExternalMcpCalled", {
        server: server.id,
        tool,
        effect: policy.effect,
        ...(policy.effect === "write" ? { mode: policy.mode } : {}),
        ok: !result.isError,
        called: true,
        ms: result.ms,
        ...(ctx.principal ? { principal: ctx.principal } : {}),
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        // Keys only, and only when asked for: an argument value carries the
        // customer, the repo, the row. Never the result — that is the body.
        ...(opts.auditArgKeys ? { argKeys: Object.keys(args).sort() } : {}),
      });
      return result;
    },

    hydrate: async () => {
      if (!opts.store) return 0;
      const loaded = await opts.store.loadExternalMcpTools();
      for (const record of loaded) {
        records.set(recordKey(record.scope, record.server, record.tool), record);
      }
      return loaded.length;
    },

    close: async () => {
      for (const client of clients.values()) await client.close().catch(() => {});
      clients.clear();
    },
  };
}

/**
 * Load servers from `LACREW_MCP_SERVERS` (inline JSON or a path to a JSON
 * file). Empty when unset: a workspace with no external MCP is the normal
 * state, not an error.
 */
export function loadExternalMcpServersFromEnv(
  env: Record<string, string | undefined> = process.env,
  readFile?: (path: string) => string,
): ExternalMcpServer[] {
  const raw = env.LACREW_MCP_SERVERS?.trim();
  if (!raw) return [];
  let text = raw;
  if (!raw.startsWith("[") && !raw.startsWith("{")) {
    if (!readFile) throw new Error("mcp_server_config_unreadable: no file reader supplied");
    text = readFile(raw);
  }
  const parsed = JSON.parse(text) as ExternalMcpServer[] | { servers: ExternalMcpServer[] };
  const entries = Array.isArray(parsed) ? parsed : parsed.servers;
  if (!Array.isArray(entries)) throw new Error("mcp_server_config_invalid: expected an array");
  return entries;
}

/**
 * How often attached servers are re-read, in minutes (`LACREW_MCP_REFRESH_MINUTES`,
 * default hourly, `0` disables the sweep).
 *
 * A refresh admits nothing, so the cadence is about *visibility*: how long a
 * tool that appeared on a server can sit there before an operator is told it is
 * being blocked. Bounded below at a minute because the sweep it rides fires
 * once a minute and a smaller number would just mean "every tick".
 */
export function externalMcpRefreshMinutes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.LACREW_MCP_REFRESH_MINUTES?.trim();
  if (raw === undefined || raw === "") return 60;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return 60;
  return minutes === 0 ? 0 : Math.max(1, Math.floor(minutes));
}

/** `LACREW_MCP_AUDIT_ARGS=1` — argument *keys* on the trail, never values. */
export function externalMcpAuditArgKeys(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.LACREW_MCP_AUDIT_ARGS === "1";
}

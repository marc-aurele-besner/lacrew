/**
 * Connectors — how a crew reaches the world it actually works in.
 *
 * Flows could only call the nine `lacrew_*` tools, which meant a crew could
 * reason about text handed to it and gate a spend, but could not read a pull
 * request, queue a post, or fetch a pool. Every crew blueprint's real work
 * happens somewhere else, so the pipelines stopped at the edge of the thing
 * they exist to do.
 *
 * A connector is an operator-registered HTTP surface a flow may call by name.
 * Four properties make it safe to hand to a flow definition that arrived as
 * untrusted JSON from a builder or a marketplace listing:
 *
 * 1. **Routes are an allowlist, never a URL.** A flow names `github.get_pr`,
 *    a route the operator registered. It cannot compose a URL, cannot change
 *    the method, and cannot reach a host nobody admitted. A `{placeholder}` in
 *    a path is filled from named args and percent-encoded, so an arg cannot
 *    escape its segment and walk to another endpoint.
 * 2. **Credentials never enter the flow.** Auth material is read from the
 *    environment at call time. Args cannot set headers, and a definition that
 *    names a connector never sees its token.
 * 3. **Writes are declared.** A route says whether it reads or writes. A write
 *    route may name a `policyTarget` — an address standing for the authority to
 *    take that action — so "may this crew merge?" is asked of the same policy
 *    stack that answers "may this crew spend?", and is admitted or revoked by
 *    the same governance.
 * 4. **Every call is audited.** Connector, route, status, and duration land on
 *    the audit trail. Never the response body, never the token.
 *
 * What this is not: a general HTTP client for agents. An agent cannot reach
 * anything the operator did not write down, which is the whole point.
 */

import type { ProtocolEvent } from "@lacrew/core";
import { resolveConnectorConfig, type ConnectorConfigEntry } from "./connectorPresets.js";

export type ConnectorAuth =
  | { kind: "none" }
  /** `Authorization: Bearer <env value>`. */
  | { kind: "bearer"; tokenEnv: string }
  /** A fixed header whose value is read from the environment. */
  | { kind: "header"; header: string; valueEnv: string };

export type ConnectorRoute = {
  /** Suffix a flow calls as `<connector>.<name>`, e.g. `get_pull_request`. */
  name: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * Path relative to the connector's base URL. `{arg}` segments are filled from
   * call args and percent-encoded; an arg that is missing fails the call.
   */
  path: string;
  /** Human description; surfaced in tool listings. */
  description?: string;
  /**
   * Whether this route changes anything on the other side. A `write` is what
   * merges a PR or publishes a post, and is the reason `policyTarget` exists.
   */
  effect: "read" | "write";
  /**
   * Args allowed as query parameters (GET) or JSON body fields. Anything else a
   * flow passes is dropped rather than forwarded: a definition must not be able
   * to smuggle fields into a request the operator described.
   */
  params?: string[];
  /**
   * Address standing for "authority to take this action". When set, the caller
   * is expected to clear it with `lacrew_check_policy` first; `callConnector`
   * refuses the call without a verdict, so an unchecked write cannot happen by
   * forgetting a step.
   */
  policyTarget?: `0x${string}`;
};

export type Connector = {
  /** Prefix a flow calls, e.g. `github`. Lowercase, no dots. */
  id: string;
  /** Absolute https:// base. http:// is allowed only for loopback (local dev). */
  baseUrl: string;
  auth: ConnectorAuth;
  /**
   * Constant headers sent with every call — an API version pin (`Notion-Version`)
   * or a content negotiation the service requires. Operator-declared and fixed:
   * a flow cannot set one, and none of them may carry auth material, which is
   * why `authorization` and the auth header itself are refused here.
   */
  headers?: Record<string, string>;
  routes: ConnectorRoute[];
  /** Per-call timeout; defaults to 20s so a hung endpoint cannot hold a run open. */
  timeoutMs?: number;
};

export type ConnectorCallResult = {
  connector: string;
  route: string;
  status: number;
  ok: boolean;
  /** Parsed JSON when the response is JSON, else the raw text. */
  body: unknown;
  ms: number;
};

export type ConnectorRegistry = {
  /** Every registered connector, for tool listings and the CLI. */
  list(): Connector[];
  /** Tool names a flow may call, as `<connector>.<route>`. */
  toolNames(): string[];
  /** Whether `name` is a connector tool (as opposed to a `lacrew_*` tool). */
  handles(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<ConnectorCallResult>;
};

export type ConnectorRegistryOptions = {
  connectors: Connector[];
  /** Environment auth material is read from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Audit sink — the orchestrator passes `runtime.recordAudit`. */
  onEvent?: (event: ProtocolEvent) => void;
  /**
   * Verdict lookup for a route with a `policyTarget`. Returning anything but
   * "ALLOW" refuses the call. Absent, every policy-targeted route is refused:
   * a registry that cannot ask must not answer for the policy stack.
   */
  checkPolicy?: (target: `0x${string}`) => Promise<string>;
};

const DEFAULT_TIMEOUT_MS = 20_000;

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

/**
 * Reject a connector the operator got wrong, at registration rather than at the
 * first call inside a run. Everything here is a mistake that would otherwise
 * surface as a confusing failure hours later, or — for the scheme rule — as
 * credentials on the wire in cleartext.
 */
export function validateConnector(connector: Connector): string[] {
  const errors: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(connector.id ?? "")) {
    errors.push(`connector id "${connector.id}" must be lowercase letters, digits, or dashes`);
  }
  let base: URL | undefined;
  try {
    base = new URL(connector.baseUrl);
  } catch {
    errors.push(`connector "${connector.id}" baseUrl is not a URL`);
  }
  if (base) {
    if (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopback(base))) {
      errors.push(
        `connector "${connector.id}" baseUrl must be https (http is allowed only for loopback)`,
      );
    }
  }
  if (connector.auth?.kind === "bearer" && !connector.auth.tokenEnv?.trim()) {
    errors.push(`connector "${connector.id}" bearer auth needs tokenEnv`);
  }
  if (connector.auth?.kind === "header") {
    if (!connector.auth.header?.trim()) errors.push(`connector "${connector.id}" needs a header name`);
    if (!connector.auth.valueEnv?.trim()) errors.push(`connector "${connector.id}" needs valueEnv`);
  }
  if (!connector.routes?.length) errors.push(`connector "${connector.id}" has no routes`);

  const authHeaderName =
    connector.auth?.kind === "bearer"
      ? "authorization"
      : connector.auth?.kind === "header"
        ? connector.auth.header?.trim().toLowerCase()
        : undefined;
  for (const [name, value] of Object.entries(connector.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      errors.push(`connector "${connector.id}" header "${name}" is not a header name`);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`connector "${connector.id}" header "${name}" has no value`);
    }
    // A constant header that could set credentials would be a second, unaudited
    // way to authenticate — and one the operator reads as harmless metadata.
    if (name.toLowerCase() === "authorization" || name.toLowerCase() === authHeaderName) {
      errors.push(`connector "${connector.id}" header "${name}" would override the credential`);
    }
  }

  const seen = new Set<string>();
  for (const route of connector.routes ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(route.name ?? "")) {
      errors.push(`route "${route.name}" must be lowercase letters, digits, or underscores`);
    } else if (seen.has(route.name)) {
      errors.push(`duplicate route "${connector.id}.${route.name}"`);
    } else {
      seen.add(route.name);
    }
    if (!route.path?.startsWith("/")) {
      errors.push(`route "${connector.id}.${route.name}" path must start with "/"`);
    }
    if (route.effect !== "read" && route.effect !== "write") {
      errors.push(`route "${connector.id}.${route.name}" needs effect read | write`);
    }
    if (route.policyTarget && !/^0x[0-9a-fA-F]{40}$/.test(route.policyTarget)) {
      errors.push(`route "${connector.id}.${route.name}" policyTarget must be a 0x address`);
    }
    // A read that claims to need policy is a contradiction the operator should
    // resolve: the check would gate nothing, and reading it as a control later
    // is exactly the kind of comfortable mistake this file exists to avoid.
    if (route.policyTarget && route.effect === "read") {
      errors.push(`route "${connector.id}.${route.name}" is a read and cannot carry a policyTarget`);
    }
  }
  return errors;
}

/** Fill `{arg}` segments from args, percent-encoded so nothing escapes a segment. */
function renderPath(route: ConnectorRoute, args: Record<string, unknown>): string {
  return route.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => {
    const value = args[key];
    if (value === undefined || value === null || `${value}`.trim() === "") {
      throw new Error(`connector_missing_arg:${key}`);
    }
    return encodeURIComponent(String(value));
  });
}

function authHeaders(
  connector: Connector,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const auth = connector.auth ?? { kind: "none" as const };
  if (auth.kind === "bearer") {
    const token = env[auth.tokenEnv]?.trim();
    if (!token) throw new Error(`connector_missing_credential:${auth.tokenEnv}`);
    return { authorization: `Bearer ${token}` };
  }
  if (auth.kind === "header") {
    const value = env[auth.valueEnv]?.trim();
    if (!value) throw new Error(`connector_missing_credential:${auth.valueEnv}`);
    return { [auth.header.toLowerCase()]: value };
  }
  return {};
}

/**
 * Build the registry a flow backend dispatches unknown tool names into.
 * Invalid connectors are rejected here rather than dropped, because a silently
 * missing connector reads to the flow author as "the tool does not exist yet".
 */
export function createConnectorRegistry(opts: ConnectorRegistryOptions): ConnectorRegistry {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const byId = new Map<string, Connector>();
  for (const connector of opts.connectors) {
    const errors = validateConnector(connector);
    if (errors.length > 0) {
      throw new Error(`invalid_connector: ${errors.join("; ")}`);
    }
    byId.set(connector.id, connector);
  }

  const resolve = (name: string): { connector: Connector; route: ConnectorRoute } | undefined => {
    const dot = name.indexOf(".");
    if (dot <= 0) return undefined;
    const connector = byId.get(name.slice(0, dot));
    const route = connector?.routes.find((r) => r.name === name.slice(dot + 1));
    return connector && route ? { connector, route } : undefined;
  };

  return {
    list: () => [...byId.values()],
    toolNames: () =>
      [...byId.values()].flatMap((c) => c.routes.map((r) => `${c.id}.${r.name}`)),
    handles: (name) => resolve(name) !== undefined,
    call: async (name, args) => {
      const hit = resolve(name);
      if (!hit) throw new Error(`unknown_connector_tool:${name}`);
      const { connector, route } = hit;

      if (route.policyTarget) {
        if (!opts.checkPolicy) {
          throw new Error(`connector_policy_unavailable:${name}`);
        }
        const verdict = await opts.checkPolicy(route.policyTarget);
        if (verdict !== "ALLOW") {
          // Reported as a refusal, not a failure: the crew asked and was told
          // no, which is a normal outcome the flow's deny path handles.
          throw new Error(`connector_denied:${name}:${verdict}`);
        }
      }

      const url = new URL(
        `${connector.baseUrl.replace(/\/$/, "")}${renderPath(route, args)}`,
      );
      const allowed = new Set(route.params ?? []);
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (allowed.has(key)) payload[key] = value;
      }
      const hasBody = route.method !== "GET" && route.method !== "DELETE";
      if (!hasBody) {
        for (const [key, value] of Object.entries(payload)) {
          url.searchParams.set(key, String(value));
        }
      }

      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        connector.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      let status = 0;
      let body: unknown;
      try {
        const res = await fetchImpl(url.toString(), {
          method: route.method,
          headers: {
            accept: "application/json",
            ...(hasBody ? { "content-type": "application/json" } : {}),
            // Auth last: validation already refuses a constant header that would
            // shadow it, and the ordering keeps that true if validation changes.
            ...(connector.headers ?? {}),
            ...authHeaders(connector, env),
          },
          ...(hasBody ? { body: JSON.stringify(payload) } : {}),
          signal: controller.signal,
        });
        status = res.status;
        const text = await res.text();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
      } finally {
        clearTimeout(timer);
      }

      const result: ConnectorCallResult = {
        connector: connector.id,
        route: route.name,
        status,
        ok: status >= 200 && status < 300,
        body,
        ms: Date.now() - started,
      };
      // The payload records what was called and how it went. Never the response
      // body — a PR diff or a draft post has no business in an audit row — and
      // never the credential.
      opts.onEvent?.({
        type: "ToolCalled",
        at: new Date().toISOString(),
        payload: {
          connector: connector.id,
          route: route.name,
          method: route.method,
          effect: route.effect,
          status,
          ok: result.ok,
          ms: result.ms,
          policyChecked: Boolean(route.policyTarget),
        },
      });
      return result;
    },
  };
}

/**
 * Load connectors from `LACREW_CONNECTORS` (inline JSON or a path to a JSON
 * file). Returns an empty registry when unset: a crew with no connectors is the
 * normal state, not an error.
 *
 * An entry may be a connector written out in full, or `{"preset":"github", …}`
 * naming one that ships (`connectorPresets.ts`). A preset expands to the same
 * plain connector and is validated identically — it saves the transcription,
 * not the operator's decision, and a preset write still refuses to register
 * until its policy target is bound.
 */
export function loadConnectorsFromEnv(
  env: Record<string, string | undefined> = process.env,
  readFile?: (path: string) => string,
): Connector[] {
  const raw = env.LACREW_CONNECTORS?.trim();
  if (!raw) return [];
  let text = raw;
  if (!raw.startsWith("[") && !raw.startsWith("{")) {
    if (!readFile) throw new Error("connector_config_unreadable: no file reader supplied");
    text = readFile(raw);
  }
  const parsed = JSON.parse(text) as
    | ConnectorConfigEntry[]
    | { connectors: ConnectorConfigEntry[] };
  const entries = Array.isArray(parsed) ? parsed : parsed.connectors;
  if (!Array.isArray(entries)) throw new Error("connector_config_invalid: expected an array");
  return resolveConnectorConfig(entries);
}

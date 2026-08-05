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
 *    escape its segment and walk to another endpoint. A route may narrow an
 *    argument further still — `argRules` pins a value to a pattern, a set, or a
 *    size, which is how "this crew may only push to `dependabot/*`" is a
 *    property of the registration rather than a sentence in a prompt.
 * 2. **Credentials never enter the flow.** Auth material is read from the
 *    environment at call time. Args cannot set headers, and a definition that
 *    names a connector never sees its token.
 * 3. **Writes are declared.** A route says whether it reads or writes. A write
 *    route may name a `policyTarget` — an address standing for the authority to
 *    take that action — so "may this crew merge?" is asked of the same policy
 *    stack that answers "may this crew spend?", and is admitted or revoked by
 *    the same governance. A write also runs in a **mode** — `auto`, `ask`, or
 *    `deny` (`connectorPolicy.ts`) — which can only ever narrow what policy
 *    already admitted: require a human to confirm in-thread, or refuse the
 *    route outright without reaching the network.
 * 4. **Every call is audited.** Connector, route, status, and duration land on
 *    the audit trail. Never the response body, never the token.
 *
 * What this is not: a general HTTP client for agents. An agent cannot reach
 * anything the operator did not write down, which is the whole point.
 */

import type { ProtocolEvent } from "@lacrew/core";
import type { ConnectorAsksSurface } from "./connectorAsks.js";
import {
  isConnectorWriteMode,
  type ConnectorModeResolution,
  type ConnectorModeSubject,
  type ConnectorWriteMode,
} from "./connectorPolicy.js";
import { resolveConnectorConfig, type ConnectorConfigEntry } from "./connectorPresets.js";
import { crewIdForSeat } from "./inferenceBudgets.js";
import {
  createGithubAppTokenSource,
  type GithubAppAuth,
  type GithubAppTokenSource,
} from "./githubApp.js";

export type ConnectorAuth =
  | { kind: "none" }
  /** `Authorization: Bearer <env value>`. */
  | { kind: "bearer"; tokenEnv: string }
  /** A fixed header whose value is read from the environment. */
  | { kind: "header"; header: string; valueEnv: string }
  /**
   * A GitHub App installation. Unlike the others this is not a static string:
   * an app id and a private key are exchanged for an hourly installation
   * token, cached and refreshed by the registry (`githubApp.ts`). Preferred
   * over a personal token — it is scoped to the repos the App was installed
   * on, has its own identity in GitHub's audit log, and can be revoked without
   * taking away a person's own access.
   */
  | GithubAppAuth;

/**
 * What one argument of a route is allowed to be.
 *
 * The param allowlist answers "which fields may a flow set". This answers "and
 * what may they say" — the difference between registering a route that can push
 * to a branch and registering one that can push to *this* branch. A rule is
 * checked before the request is built, so a refused value never reaches the
 * network, and the refusal names the argument without echoing what was in it.
 *
 * Rules are operator configuration, at the same trust level as the base URL: a
 * `pattern` is compiled and run against caller-supplied values, so write it
 * yourself rather than accepting one from a marketplace listing.
 */
export type ConnectorArgRule = {
  /**
   * This rule in the operator's own words — `dependabot/**, renovate/**` rather
   * than the regex it compiled to. Purely for the surfaces that show a crew's
   * reach; nothing is enforced from it, and a rule without one is still a rule.
   */
  label?: string;
  /**
   * The call fails without this argument. Body and query args are optional by
   * default, which is usually right and occasionally dangerous: GitHub commits
   * to the *default branch* when a write leaves `branch` out, so the branch
   * allowlist would constrain a field nobody sent. A path arg is always
   * required; saying so again here is harmless.
   */
  required?: boolean;
  /**
   * Regex the value must match **whole** — it is anchored for you, so
   * `dependabot/.+` cannot be slipped past with a prefix.
   */
  pattern?: string;
  /** The complete set of accepted values. */
  oneOf?: string[];
  /**
   * Largest the value may be, in UTF-8 bytes, as the flow supplied it. Checked
   * before `encode`, so the number is the one an author reasons about (a file's
   * text) rather than its transport size.
   */
  maxBytes?: number;
  /**
   * Path args only: the value may span segments, e.g. a repo path like
   * `src/index.ts` or a branch like `renovate/lockfile`. Each segment is
   * percent-encoded separately and `.`, `..`, and empties are refused, so a
   * multi-segment arg still cannot walk out of where the path put it.
   *
   * Without this a path arg is one segment and its slashes are encoded, which
   * is the right default: most path args are an owner, a repo, or a number.
   */
  multiSegment?: boolean;
  /**
   * Body args only: send the value base64-encoded. GitHub's Contents API takes
   * a file that way, and the alternative is asking a model to emit base64 —
   * a step that fails silently by producing something that decodes to garbage.
   */
  encode?: "base64";
};

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
   * Per-argument constraints, by argument name. Names a path placeholder or an
   * entry of `params`; anything else is a typo and refused at registration
   * rather than silently constraining nothing.
   */
  argRules?: Record<string, ConnectorArgRule>;
  /**
   * Constant headers for this route only — a media type the endpoint needs that
   * the rest of the connector does not. Same refusal as the connector's own:
   * none of them may carry auth material.
   */
  headers?: Record<string, string>;
  /**
   * Largest request body this route may send, in bytes. Overrides the
   * connector's, which overrides the registry default. A write that carries a
   * file is the reason this exists: without it the only bound on what a crew
   * uploads is what a model happened to emit.
   */
  maxRequestBytes?: number;
  /**
   * Address standing for "authority to take this action". When set, the caller
   * is expected to clear it with `lacrew_check_policy` first; `callConnector`
   * refuses the call without a verdict, so an unchecked write cannot happen by
   * forgetting a step.
   */
  policyTarget?: `0x${string}`;
  /**
   * Default write mode for this route when no operator rule narrows it
   * (`connectorPolicy.ts`). Omitted means `auto`. A preset sets `ask` on the
   * routes whose mistakes are public and hard to take back — a merge, a
   * publish — because the safe default is the one an operator has to *widen*
   * rather than the one they have to remember to narrow.
   *
   * Meaningless on a read, and refused there: a confirmation that gates
   * nothing teaches operators to click through confirmations.
   */
  mode?: ConnectorWriteMode;
  /**
   * Largest response body this route may return, in bytes. Overrides the
   * connector's own limit, which overrides the registry default.
   *
   * Set it where the route's size is a property of the endpoint rather than of
   * the deployment: a route that lists every pool on every chain is bulk by
   * nature, and the honest options are a raised ceiling written down next to it
   * or a refusal the operator can see coming. A description that mentions
   * megabytes is documentation; this is the limit.
   */
  maxResponseBytes?: number;
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
  /**
   * Largest response body any route here may return, in bytes. Overrides the
   * registry default; a route may narrow or widen it again.
   */
  maxResponseBytes?: number;
  /**
   * Largest request body any route here may send, in bytes. Overrides the
   * registry default; a route may narrow or widen it again.
   */
  maxRequestBytes?: number;
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

/** A route as it is safe to publish: shape and gating, never a credential. */
export type ConnectorRouteView = {
  name: string;
  method: ConnectorRoute["method"];
  path: string;
  description?: string;
  effect: "read" | "write";
  params: string[];
  /** The address gating this route, or null. Public by design — admitting it is. */
  policyTarget: string | null;
  /** The route's declared default mode; null on reads, which carry none. */
  mode: ConnectorWriteMode | null;
  /**
   * The mode that would actually apply, and what decided it. Null on reads.
   * Resolved for the subject `describe()` was asked about — an operator surface
   * showing a workspace default beside a seat that overrides it is showing the
   * one number nobody's flow will run under.
   */
  effectiveMode: ConnectorModeResolution | null;
  /**
   * Bytes this route will accept back before refusing, already resolved
   * through route → connector → registry default. Always a number: an operator
   * asking "why did that step fail" needs the limit that actually applied, not
   * the one place it happened to be written down.
   */
  maxResponseBytes: number;
  /** Same, for what this route will send. Resolved the same way. */
  maxRequestBytes: number;
  /**
   * The constraints on this route's arguments, as registered. Public by design:
   * "which branches may this crew push to" is the operator's own decision and
   * the answer belongs on the surface where they read what the crew can do.
   */
  argRules?: Record<string, ConnectorArgRule>;
};

/**
 * A connector as it is safe to publish to an operator surface. Names the env
 * vars it reads and whether they are set, never a value: "is my token there?"
 * is the question an operator actually has, and it can be answered without
 * revealing anything.
 */
export type ConnectorView = {
  id: string;
  baseUrl: string;
  timeoutMs: number;
  /** The limit routes here inherit when they declare none of their own. */
  maxResponseBytes: number;
  /** The limit routes here inherit for what they send. */
  maxRequestBytes: number;
  auth: {
    kind: ConnectorAuth["kind"];
    envVars: string[];
    /** Every env var this connector needs is present. */
    ready: boolean;
    /** `github-app` only: whether an installation token is currently held. */
    installationToken?: { cached: boolean; expiresAt: string | null };
  };
  routes: ConnectorRouteView[];
};

/**
 * Who is making a call, and on whose behalf.
 *
 * Every field is optional because a call can arrive without a run behind it
 * (`POST /mcp/call` from an operator), but a write in `ask` mode needs enough
 * of it to address a question and to resume the run afterwards. Absent a
 * principal the question goes to the org thread, which is the honest place for
 * "somebody asked this orchestrator to do something".
 */
export type ConnectorCallContext = ConnectorModeSubject & {
  flowId?: string;
  runId?: string;
  /** Overrides the default `agent:<principal>` thread for an ask. */
  threadId?: string;
};

export type ConnectorRegistry = {
  /** Every registered connector, for tool listings and the CLI. */
  list(): Connector[];
  /** Tool names a flow may call, as `<connector>.<route>`. */
  toolNames(): string[];
  /** Whether `name` is a connector tool (as opposed to a `lacrew_*` tool). */
  handles(name: string): boolean;
  /**
   * Whether a route reads or writes, by tool name; undefined when this registry
   * does not hold it. Read by plan-required mode (F2.31), which gates writes
   * and must never gate a read.
   */
  effectOf(name: string): "read" | "write" | undefined;
  call(
    name: string,
    args: Record<string, unknown>,
    ctx?: ConnectorCallContext,
  ): Promise<ConnectorCallResult>;
  /** Wiring state for an operator surface. Contains no credential material. */
  describe(subject?: ConnectorModeSubject): ConnectorView[];
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
  /**
   * Resolves the mode a write route runs in for one caller. Absent, every write
   * runs at its declared default — which is `auto` unless the route says
   * otherwise, i.e. exactly the behaviour connectors had before modes existed.
   */
  resolveMode?: (
    route: ConnectorRoute,
    connectorId: string,
    subject: ConnectorModeSubject,
  ) => ConnectorModeResolution;
  /**
   * Ask-mode machinery. Absent, an `ask` route is refused rather than called:
   * a registry with nowhere to put the question cannot answer it, and calling
   * anyway would turn "confirm this first" into "do it".
   */
  asks?: Pick<ConnectorAsksSurface, "gate">;
  /** Injected for tests so token expiry is drivable; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Default response ceiling for connectors that declare none, in bytes.
   * Defaults to `DEFAULT_MAX_RESPONSE_BYTES`. This is the deployment-wide knob;
   * a connector or a route narrows or widens it from there.
   */
  maxResponseBytes?: number;
  /**
   * Default request ceiling for connectors that declare none, in bytes.
   * Defaults to `DEFAULT_MAX_REQUEST_BYTES`.
   */
  maxRequestBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How much of a response a connector will read before refusing, when nothing
 * narrower is declared.
 *
 * A flow step's body is stringified into `{{steps.<id>.json}}` and handed to
 * whatever reads it next — usually a model prompt. Without a ceiling, one call
 * to a bulk listing route is an eleven-megabyte prompt, billed and truncated
 * somewhere downstream where the cause is invisible. One mebibyte is well past
 * any single record a crew reasons about and well under the size where that
 * happens.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * How much a connector will send in one request before refusing, when nothing
 * narrower is declared.
 *
 * The response ceiling bounds what a crew reads; this bounds what it *does*. A
 * write route that carries a file takes its content from a model completion,
 * and a model that loops or pastes its whole context produces a body nobody
 * sized. One mebibyte is far past any patch a fixer should be writing and far
 * under the size where an accident becomes an incident on the other side.
 */
export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

/** Env vars a connector reads for auth — what an operator must set. */
export function connectorEnvVars(connector: Connector): string[] {
  const auth = connector.auth ?? { kind: "none" as const };
  if (auth.kind === "bearer") return [auth.tokenEnv];
  if (auth.kind === "header") return [auth.valueEnv];
  if (auth.kind === "github-app") {
    return [auth.appIdEnv, auth.privateKeyEnv, auth.installationIdEnv];
  }
  return [];
}

/**
 * Read a response body, refusing rather than returning one over `limit` bytes.
 *
 * Refusing beats truncating. A truncated JSON body is invalid JSON, so it lands
 * in `{{steps.<id>.json}}` as a string that looks like data and reasons like
 * noise — a model asked to classify a pull request from half an object will
 * answer something, and nothing downstream can tell that from an answer. A
 * refusal is a step failure with a code an operator can act on.
 *
 * The counting is streamed, so an oversized body is dropped mid-flight instead
 * of being buffered whole and measured afterwards — the eleven-megabyte
 * allocation is the thing being prevented, not just its use.
 */
async function readBounded(res: Response, limit: number, tool: string): Promise<string> {
  const tooLarge = (): Error => new Error(`connector_response_too_large:${tool}:${limit}`);

  // Free when the server declares it: refuse before reading a byte. The header
  // counts encoded bytes, so it only ever under-states a compressed body —
  // over the limit here is over the limit decoded too.
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();

  // No stream to read (a mocked response, a 204). `text()` is bounded by what
  // is already in hand, so measuring after the fact is all that is left.
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text) > limit) throw tooLarge();
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    // Tells the server we are done on the refusal path; a no-op once drained.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Undefined passes: the field is optional and inherits. A bad value does not. */
function isPositiveInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value > 0);
}

/** Whether params ride in a JSON body rather than the query string. */
function sendsBody(method: ConnectorRoute["method"]): boolean {
  return method !== "GET" && method !== "DELETE";
}

/** The `{placeholder}` names a path fills from args. */
function pathArgNames(path: string): string[] {
  return [...(path ?? "").matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!);
}

/**
 * Constant headers, wherever they are declared. A header that could set
 * credentials would be a second, unaudited way to authenticate — and one the
 * operator reads as harmless metadata.
 */
function headerErrors(
  where: string,
  headers: Record<string, string> | undefined,
  authHeaderName: string | undefined,
): string[] {
  const errors: string[] = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      errors.push(`${where} header "${name}" is not a header name`);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${where} header "${name}" has no value`);
    }
    if (name.toLowerCase() === "authorization" || name.toLowerCase() === authHeaderName) {
      errors.push(`${where} header "${name}" would override the credential`);
    }
  }
  return errors;
}

/**
 * Anchor an operator's pattern so it matches the whole value. An unanchored
 * `dependabot/.+` would admit `evil/dependabot/x`, which is the mistake a
 * branch allowlist exists to prevent.
 */
export function wholeValueRegExp(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`);
}

/** Rules that constrain nothing, or constrain an argument the route never takes. */
function argRuleErrors(connectorId: string, route: ConnectorRoute): string[] {
  const errors: string[] = [];
  const where = `route "${connectorId}.${route.name}"`;
  const inPath = new Set(pathArgNames(route.path ?? ""));
  const inParams = new Set(route.params ?? []);
  for (const [arg, rule] of Object.entries(route.argRules ?? {})) {
    if (!inPath.has(arg) && !inParams.has(arg)) {
      errors.push(`${where} argRules names "${arg}", which the route does not take`);
      continue;
    }
    if (rule.pattern !== undefined) {
      try {
        wholeValueRegExp(rule.pattern);
      } catch {
        errors.push(`${where} argRules "${arg}" pattern is not a regular expression`);
      }
    }
    if (rule.oneOf !== undefined && rule.oneOf.length === 0) {
      // A rule that admits nothing refuses every call, which reads as a broken
      // connector rather than as the empty list it was.
      errors.push(`${where} argRules "${arg}" oneOf is empty`);
    }
    if (!isPositiveInteger(rule.maxBytes)) {
      errors.push(`${where} argRules "${arg}" maxBytes must be a positive integer`);
    }
    if (rule.multiSegment && !inPath.has(arg)) {
      errors.push(`${where} argRules "${arg}" is not a path argument and cannot be multiSegment`);
    }
    if (rule.encode && !inParams.has(arg)) {
      // Encoding a path argument would produce a segment nobody can read back,
      // and the caller would be describing a resource that does not exist.
      errors.push(`${where} argRules "${arg}" is not a body argument and cannot be encoded`);
    }
    if (rule.encode && !sendsBody(route.method)) {
      errors.push(`${where} sends no body, so argRules "${arg}" cannot be encoded`);
    }
  }
  return errors;
}

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
    if (!connector.auth.header?.trim())
      errors.push(`connector "${connector.id}" needs a header name`);
    if (!connector.auth.valueEnv?.trim()) errors.push(`connector "${connector.id}" needs valueEnv`);
  }
  if (connector.auth?.kind === "github-app") {
    // All three or none: two of the three mints nothing, and the failure would
    // land on the first call inside a run rather than here.
    for (const field of ["appIdEnv", "privateKeyEnv", "installationIdEnv"] as const) {
      if (!connector.auth[field]?.trim()) {
        errors.push(`connector "${connector.id}" github-app auth needs ${field}`);
      }
    }
  }
  if (!connector.routes?.length) errors.push(`connector "${connector.id}" has no routes`);
  if (!isPositiveInteger(connector.maxResponseBytes)) {
    errors.push(`connector "${connector.id}" maxResponseBytes must be a positive integer`);
  }
  if (!isPositiveInteger(connector.maxRequestBytes)) {
    errors.push(`connector "${connector.id}" maxRequestBytes must be a positive integer`);
  }

  const authHeaderName =
    connector.auth?.kind === "bearer"
      ? "authorization"
      : connector.auth?.kind === "header"
        ? connector.auth.header?.trim().toLowerCase()
        : undefined;
  errors.push(...headerErrors(`connector "${connector.id}"`, connector.headers, authHeaderName));

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
      errors.push(
        `route "${connector.id}.${route.name}" is a read and cannot carry a policyTarget`,
      );
    }
    if (route.mode !== undefined && !isConnectorWriteMode(route.mode)) {
      errors.push(`route "${connector.id}.${route.name}" mode must be auto | ask | deny`);
    }
    // Same reasoning as the policy target above: a read that declares a mode is
    // a control that would gate nothing, and reading it as one later is the
    // comfortable mistake this file exists to avoid.
    if (route.mode && route.effect === "read") {
      errors.push(`route "${connector.id}.${route.name}" is a read and cannot carry a mode`);
    }
    // Unlike a mode or a policy target, this one is meaningful on a read —
    // reads are where the bulk listings are. Only its value is checked: a zero
    // or a fraction refuses every call, which reads as "the connector is
    // broken" hours later rather than as the typo it was.
    if (!isPositiveInteger(route.maxResponseBytes)) {
      errors.push(
        `route "${connector.id}.${route.name}" maxResponseBytes must be a positive integer`,
      );
    }
    if (!isPositiveInteger(route.maxRequestBytes)) {
      errors.push(
        `route "${connector.id}.${route.name}" maxRequestBytes must be a positive integer`,
      );
    }
    errors.push(
      ...headerErrors(`route "${connector.id}.${route.name}"`, route.headers, authHeaderName),
    );
    errors.push(...argRuleErrors(connector.id, route));
  }
  return errors;
}

/**
 * Hold a value to the route's rule, or refuse the call.
 *
 * The error names the tool and the argument and never the value: a refused
 * branch name is uninteresting, and a refused file body would put the whole
 * thing in a log line and an audit row.
 */
function checkArgRule(
  tool: string,
  arg: string,
  raw: string,
  rule: ConnectorArgRule | undefined,
): void {
  if (!rule) return;
  if (rule.maxBytes !== undefined && Buffer.byteLength(raw) > rule.maxBytes) {
    throw new Error(`connector_arg_too_large:${tool}:${arg}:${rule.maxBytes}`);
  }
  if (rule.oneOf && !rule.oneOf.includes(raw)) {
    throw new Error(`connector_arg_refused:${tool}:${arg}`);
  }
  if (rule.pattern && !wholeValueRegExp(rule.pattern).test(raw)) {
    throw new Error(`connector_arg_refused:${tool}:${arg}`);
  }
}

/**
 * Encode a multi-segment path argument one segment at a time.
 *
 * The slashes survive — that is the point, a branch is `renovate/lockfile` and
 * a file is `src/index.ts` — but `.`, `..`, and empty segments do not, so the
 * value can still only name something *inside* where the path put it.
 */
function encodeSegments(tool: string, arg: string, raw: string): string {
  const parts = raw.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new Error(`connector_arg_refused:${tool}:${arg}`);
    }
  }
  return parts.map(encodeURIComponent).join("/");
}

/** Fill `{arg}` segments from args, percent-encoded so nothing escapes a segment. */
function renderPath(tool: string, route: ConnectorRoute, args: Record<string, unknown>): string {
  return route.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => {
    const value = args[key];
    if (value === undefined || value === null || `${value}`.trim() === "") {
      throw new Error(`connector_missing_arg:${key}`);
    }
    const raw = String(value);
    const rule = route.argRules?.[key];
    checkArgRule(tool, key, raw, rule);
    return rule?.multiSegment ? encodeSegments(tool, key, raw) : encodeURIComponent(raw);
  });
}

async function authHeaders(
  connector: Connector,
  env: Record<string, string | undefined>,
  githubApp: GithubAppTokenSource,
): Promise<Record<string, string>> {
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
  if (auth.kind === "github-app") {
    const token = await githubApp.get({
      cacheKey: connector.id,
      baseUrl: connector.baseUrl,
      auth,
      env,
    });
    return { authorization: `Bearer ${token}` };
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
  const githubApp = createGithubAppTokenSource({ fetchImpl, now: opts.now });
  const byId = new Map<string, Connector>();
  for (const connector of opts.connectors) {
    const errors = validateConnector(connector);
    if (errors.length > 0) {
      throw new Error(`invalid_connector: ${errors.join("; ")}`);
    }
    byId.set(connector.id, connector);
  }

  const defaultMaxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  /** Route wins, then connector, then the deployment default. */
  const maxBytesFor = (connector: Connector, route: ConnectorRoute): number =>
    route.maxResponseBytes ?? connector.maxResponseBytes ?? defaultMaxBytes;

  const defaultMaxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  /** Same precedence, for what goes out. */
  const maxRequestBytesFor = (connector: Connector, route: ConnectorRoute): number =>
    route.maxRequestBytes ?? connector.maxRequestBytes ?? defaultMaxRequestBytes;

  const resolve = (name: string): { connector: Connector; route: ConnectorRoute } | undefined => {
    const dot = name.indexOf(".");
    if (dot <= 0) return undefined;
    const connector = byId.get(name.slice(0, dot));
    const route = connector?.routes.find((r) => r.name === name.slice(dot + 1));
    return connector && route ? { connector, route } : undefined;
  };

  return {
    list: () => [...byId.values()],
    toolNames: () => [...byId.values()].flatMap((c) => c.routes.map((r) => `${c.id}.${r.name}`)),
    handles: (name) => resolve(name) !== undefined,
    effectOf: (name) => resolve(name)?.route.effect,
    describe: (subject = {}) =>
      [...byId.values()].map((connector) => {
        const envVars = connectorEnvVars(connector);
        return {
          id: connector.id,
          baseUrl: connector.baseUrl,
          timeoutMs: connector.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxResponseBytes: connector.maxResponseBytes ?? defaultMaxBytes,
          maxRequestBytes: connector.maxRequestBytes ?? defaultMaxRequestBytes,
          auth: {
            kind: (connector.auth ?? { kind: "none" as const }).kind,
            envVars,
            // Presence only. "Is the token there?" is answerable without
            // reading it, and reading it into a response is how a status
            // surface becomes an exfiltration route.
            ready: envVars.every((name) => Boolean(env[name]?.trim())),
            ...(connector.auth?.kind === "github-app"
              ? { installationToken: githubApp.status(connector.id) }
              : {}),
          },
          routes: connector.routes.map((route) => ({
            name: route.name,
            method: route.method,
            path: route.path,
            ...(route.description ? { description: route.description } : {}),
            effect: route.effect,
            params: route.params ?? [],
            policyTarget: route.policyTarget ?? null,
            mode: route.effect === "write" ? (route.mode ?? "auto") : null,
            effectiveMode:
              route.effect === "write"
                ? (opts.resolveMode?.(route, connector.id, subject) ?? {
                    mode: route.mode ?? "auto",
                    source: { kind: "route-default" as const },
                  })
                : null,
            maxResponseBytes: maxBytesFor(connector, route),
            maxRequestBytes: maxRequestBytesFor(connector, route),
            ...(route.argRules ? { argRules: route.argRules } : {}),
          })),
        };
      }),
    call: async (name, args, ctx = {}) => {
      const hit = resolve(name);
      if (!hit) throw new Error(`unknown_connector_tool:${name}`);
      const { connector, route } = hit;

      // Modes only narrow, so `deny` is answered first: there is no reading of
      // the policy stack that would let a refused route through, and asking the
      // chain about a call that is never going out is a read for nothing.
      const mode =
        route.effect === "write"
          ? (opts.resolveMode?.(route, connector.id, ctx).mode ?? route.mode ?? "auto")
          : "auto";
      if (mode === "deny") {
        // Distinct from `connector_denied`: the operator refused this route, the
        // policy stack did not. Collapsing the two would have an operator
        // hunting a governance change that never happened.
        throw new Error(`connector_mode_denied:${name}`);
      }

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

      const path = renderPath(name, route, args);
      const url = new URL(`${connector.baseUrl.replace(/\/$/, "")}${path}`);
      const allowed = new Set(route.params ?? []);
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (!allowed.has(key)) continue;
        const rule = route.argRules?.[key];
        if (!rule) {
          payload[key] = value;
          continue;
        }
        const raw = String(value ?? "");
        checkArgRule(name, key, raw, rule);
        payload[key] =
          rule.encode === "base64" ? Buffer.from(raw, "utf8").toString("base64") : value;
      }
      // Checked after the loop because an argument nobody passed never enters
      // it: the failure this catches is the field being absent, not wrong.
      for (const [key, rule] of Object.entries(route.argRules ?? {})) {
        if (!rule.required || !allowed.has(key)) continue;
        if (String(payload[key] ?? "").trim() === "") {
          throw new Error(`connector_missing_arg:${key}`);
        }
      }
      const hasBody = sendsBody(route.method);
      if (!hasBody) {
        for (const [key, value] of Object.entries(payload)) {
          url.searchParams.set(key, String(value));
        }
      }
      // Sized once, on exactly the bytes that would go out. A body assembled
      // from a model completion has no other bound: the response ceiling says
      // nothing about what a crew sends, and the other side's limit is found
      // out by hitting it, after the request has already been made.
      const requestBody = hasBody ? JSON.stringify(payload) : undefined;
      const maxRequestBytes = maxRequestBytesFor(connector, route);
      if (requestBody !== undefined && Buffer.byteLength(requestBody) > maxRequestBytes) {
        throw new Error(`connector_request_too_large:${name}:${maxRequestBytes}`);
      }

      // Asked *after* the request is built, so what the human confirms is what
      // would actually go out — the filled-in path and the fields the route
      // forwards, not the raw args a flow happened to pass.
      if (mode === "ask") {
        if (!opts.asks) throw new Error(`connector_ask_unavailable:${name}`);
        await opts.asks.gate({
          connector: connector.id,
          route: route.name,
          method: route.method,
          path,
          args: payload,
          ...(ctx.principal ? { principal: ctx.principal } : {}),
          ...(ctx.flowId ? { flowId: ctx.flowId } : {}),
          ...(ctx.runId ? { runId: ctx.runId } : {}),
          ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
        });
      }

      const started = Date.now();
      const maxBytes = maxBytesFor(connector, route);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), connector.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      // Resolved before the call so the refusal path can put the same seat on
      // the trail that a successful call would have.
      const seat = ctx.principal?.trim().toLowerCase();
      const crew = crewIdForSeat(seat ?? "", [...(ctx.managers ?? [])]);
      let status = 0;
      let body: unknown;
      try {
        const send = async (): Promise<Response> =>
          fetchImpl(url.toString(), {
            method: route.method,
            headers: {
              accept: "application/json",
              ...(hasBody ? { "content-type": "application/json" } : {}),
              // Auth last: validation already refuses a constant header that
              // would shadow it, and the ordering keeps that true if validation
              // changes.
              ...(connector.headers ?? {}),
              ...(route.headers ?? {}),
              ...(await authHeaders(connector, env, githubApp)),
            },
            ...(requestBody !== undefined ? { body: requestBody } : {}),
            signal: controller.signal,
          });

        let res = await send();
        // An installation token can be revoked or expire early on GitHub's
        // side, and the cache would keep serving it until its own deadline.
        // One re-mint distinguishes a stale token from a credential that is
        // genuinely wrong; a second would just be a retry loop on a real 401.
        if (res.status === 401 && connector.auth?.kind === "github-app") {
          githubApp.invalidate(connector.id);
          res = await send();
        }
        status = res.status;
        let text: string;
        try {
          text = await readBounded(res, maxBytes, name);
        } catch (err) {
          // Only the refusal earns a row here. A stream that broke mid-read is
          // a transport failure, and labelling it "too large" would send an
          // operator to raise a limit that was never the problem.
          if (!`${(err as Error)?.message}`.startsWith("connector_response_too_large")) throw err;
          // The call went out and the other side answered — that is a side
          // effect and a cost, and a write may already have happened. Leaving
          // it off the trail would make an oversized response the one thing a
          // crew can do without a row, and the operator's first question
          // ("what did it call?") unanswerable.
          opts.onEvent?.({
            type: "ToolCalled",
            at: new Date().toISOString(),
            payload: {
              connector: connector.id,
              route: route.name,
              method: route.method,
              effect: route.effect,
              ...(seat ? { agentId: seat, crewId: crew } : {}),
              status,
              ok: false,
              ms: Date.now() - started,
              policyChecked: Boolean(route.policyTarget),
              ...(route.effect === "write" ? { mode } : {}),
              refused: "response_too_large",
              maxResponseBytes: maxBytes,
            },
          });
          throw err;
        }
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
      //
      // The seat and its crew are on the row because a connector call is a cost
      // and a side effect belonging to a desk (F2.33): without them, a period
      // report can count calls but cannot say whose they were. Addresses only —
      // the same identifiers every other row on this trail already carries.
      opts.onEvent?.({
        type: "ToolCalled",
        at: new Date().toISOString(),
        payload: {
          connector: connector.id,
          route: route.name,
          method: route.method,
          effect: route.effect,
          ...(seat ? { agentId: seat, crewId: crew } : {}),
          status,
          ok: result.ok,
          ms: result.ms,
          policyChecked: Boolean(route.policyTarget),
          ...(route.effect === "write" ? { mode } : {}),
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
    ConnectorConfigEntry[] | { connectors: ConnectorConfigEntry[] };
  const entries = Array.isArray(parsed) ? parsed : parsed.connectors;
  if (!Array.isArray(entries)) throw new Error("connector_config_invalid: expected an array");
  return resolveConnectorConfig(entries);
}

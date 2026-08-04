/**
 * Connector write policy — the mode a write route runs in (PRD F2.24).
 *
 * A `policyTarget` answers one question: is this crew *admitted* to take this
 * action? That is the right question for money and it is the only one the chain
 * can answer, because the chain cannot see a pull request. It leaves out the
 * middle case an operator asks for constantly: "policy allows the merge, and I
 * still want to be asked first." Without somewhere to put that, a flow either
 * calls or does not, and the operator's real preference lives in whether they
 * dared install the flow at all.
 *
 * So every **write** route carries a mode, and the vocabulary is deliberately
 * the onchain one turned outward:
 *
 * | Onchain verdict | Write mode | What happens |
 * | --- | --- | --- |
 * | `ALLOW` | `auto` | admitted, and called without asking |
 * | `ESCALATE` | `ask` | admitted, and a human confirms in-thread first |
 * | `DENY` | `deny` | never called, and the network is never reached |
 *
 * The parallel is the point: an operator who has learned what ESCALATE means
 * for a spend already knows what `ask` means for a publish, and does not have
 * to learn a second vocabulary for the half of the crew's behaviour that does
 * not move money.
 *
 * ## What a mode is not
 *
 * A mode is not authority. `auto` does not admit anything — a route with a
 * `policyTarget` is still checked against the policy stack first, and a DENY
 * there refuses the call whatever the mode says. Modes only ever *subtract*:
 * the most an operator can do here is require a confirmation, or refuse
 * outright. That ordering is why an operator cannot widen a crew's reach by
 * editing a dropdown, and why the two controls do not have to be reasoned
 * about together.
 *
 * Reads carry no mode at all. Gating a read would be a control that reads like
 * a safeguard and protects nothing, and it would train operators to click
 * through confirmations that never mattered — which is how the ones that do
 * matter stop being read.
 */

import type { ConnectorRoute } from "./connectors.js";

export type ConnectorWriteMode = "auto" | "ask" | "deny";

export const CONNECTOR_WRITE_MODES: ConnectorWriteMode[] = ["auto", "ask", "deny"];

export function isConnectorWriteMode(value: unknown): value is ConnectorWriteMode {
  return typeof value === "string" && CONNECTOR_WRITE_MODES.includes(value as ConnectorWriteMode);
}

/**
 * Where a rule applies.
 *
 * `workspace` is the whole orchestrator. `crew` is a team subtree, named by the
 * address of the node it hangs from — the same identity the org chart already
 * uses, so a crew rule survives a rename and cannot be pointed at a team that
 * does not exist. `agent` is one seat.
 */
export type ConnectorModeScope =
  { level: "workspace" } | { level: "crew"; ref: string } | { level: "agent"; ref: string };

export type ConnectorModeRule = {
  scope: ConnectorModeScope;
  /** `<connector>.<route>`, or `<connector>.*` for every write it has. */
  route: string;
  mode: ConnectorWriteMode;
};

/** A rule as it is stored and served; `at` is when an operator last set it. */
export type ConnectorModeRecord = ConnectorModeRule & { at: string };

/**
 * Who is making the call, for rule resolution.
 *
 * `managers` is the principal's ancestors in the org chart. A crew rule applies
 * to every seat under the node it names, which is what makes "this desk never
 * publishes" one rule rather than one per worker.
 */
export type ConnectorModeSubject = {
  principal?: string;
  managers?: Iterable<string>;
};

export type ConnectorModeResolution = {
  mode: ConnectorWriteMode;
  /** What decided it — shown in the UI so an inherited value is legible. */
  source: { kind: "route-default" } | { kind: "rule"; scope: ConnectorModeScope; route: string };
};

const norm = (value: string): string => value.trim().toLowerCase();

function scopeKey(scope: ConnectorModeScope): string {
  return scope.level === "workspace" ? "workspace" : `${scope.level}:${norm(scope.ref)}`;
}

export function parseModeScope(raw: unknown): ConnectorModeScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const level = (raw as { level?: unknown }).level;
  const ref = (raw as { ref?: unknown }).ref;
  if (level === "workspace") return { level: "workspace" };
  if (level !== "crew" && level !== "agent") return null;
  if (typeof ref !== "string" || !ref.trim()) return null;
  return { level, ref: ref.trim() };
}

/**
 * A route pattern must name a connector, and either one route or all of them.
 * Anything looser (`*`, `github.merge_*`) is refused: a glob that quietly
 * widened as routes were added is a rule an operator stops being able to read.
 */
export function validateModeRoute(route: string): string | null {
  return /^[a-z][a-z0-9-]*\.([a-z][a-z0-9_]*|\*)$/.test(route)
    ? null
    : `route "${route}" must be <connector>.<route> or <connector>.*`;
}

/**
 * The mode a write route runs in for one caller.
 *
 * Precedence is narrowest-first — agent, then crew, then workspace, then the
 * route's own default — and an exact route beats a `<connector>.*` at the same
 * level. Narrowest-first is the only ordering that lets an operator write a
 * broad rule and carve one seat out of it; the reverse would make every
 * workspace rule unoverridable and every exception a new connector.
 *
 * Among crew rules the nearest ancestor wins, so a rule on a desk beats one on
 * the division above it.
 */
export function resolveWriteMode(
  route: Pick<ConnectorRoute, "name" | "effect" | "mode">,
  connectorId: string,
  rules: readonly ConnectorModeRule[],
  subject: ConnectorModeSubject = {},
): ConnectorModeResolution {
  const fallback: ConnectorModeResolution = {
    mode: route.mode ?? "auto",
    source: { kind: "route-default" },
  };
  if (route.effect !== "write") return fallback;

  const exact = `${connectorId}.${route.name}`;
  const wildcard = `${connectorId}.*`;
  const matching = rules.filter((r) => r.route === exact || r.route === wildcard);
  if (matching.length === 0) return fallback;

  const byKey = new Map<string, ConnectorModeRule[]>();
  for (const rule of matching) {
    const key = scopeKey(rule.scope);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(rule);
    else byKey.set(key, [rule]);
  }

  const pick = (key: string): ConnectorModeResolution | null => {
    const bucket = byKey.get(key);
    if (!bucket) return null;
    // Last writer wins within a scope+pattern, so re-setting a rule replaces it.
    const hit = [...bucket].reverse().find((r) => r.route === exact) ?? [...bucket].reverse()[0];
    return hit
      ? { mode: hit.mode, source: { kind: "rule", scope: hit.scope, route: hit.route } }
      : null;
  };

  const principal = subject.principal ? norm(subject.principal) : undefined;
  if (principal) {
    const own = pick(`agent:${principal}`);
    if (own) return own;
    // The seat may also be named by a crew rule pointing straight at it.
    const asCrew = pick(`crew:${principal}`);
    if (asCrew) return asCrew;
  }
  // `managers` arrives nearest-first from `ancestorsOf`, which walks upward.
  for (const manager of subject.managers ?? []) {
    const hit = pick(`crew:${norm(manager)}`);
    if (hit) return hit;
  }
  return pick("workspace") ?? fallback;
}

/** Bounded, durable set of mode rules. */
export interface ConnectorModeStore {
  loadConnectorModes(): Promise<ConnectorModeRecord[]>;
  saveConnectorMode(record: ConnectorModeRecord): Promise<void>;
  removeConnectorMode(scopeKey: string, route: string): Promise<void>;
}

export type ConnectorModesSurface = {
  list(): ConnectorModeRecord[];
  /** Set (or replace) one rule. Returns the stored record. */
  set(rule: ConnectorModeRule): Promise<ConnectorModeRecord>;
  /** Drop a rule, falling the route back to what it inherits. */
  clear(scope: ConnectorModeScope, route: string): Promise<boolean>;
  resolve(
    route: Pick<ConnectorRoute, "name" | "effect" | "mode">,
    connectorId: string,
    subject?: ConnectorModeSubject,
  ): ConnectorModeResolution;
  hydrate(): Promise<number>;
};

/**
 * Mode rules for one orchestrator, durable through a `ConnectorModeStore`.
 *
 * Held in memory and written through, like standing agent controls: a rule that
 * vanished on restart would silently return a route to `auto`, which is the one
 * direction a control like this must never fail in.
 */
export function createConnectorModes(opts: {
  store?: ConnectorModeStore;
  /** Rules the process starts with, e.g. from configuration. */
  seed?: readonly ConnectorModeRule[];
  now?: () => Date;
}): ConnectorModesSurface {
  const now = opts.now ?? (() => new Date());
  const rules = new Map<string, ConnectorModeRecord>();
  const keyOf = (scope: ConnectorModeScope, route: string): string => `${scopeKey(scope)}|${route}`;

  for (const rule of opts.seed ?? []) {
    rules.set(keyOf(rule.scope, rule.route), { ...rule, at: now().toISOString() });
  }

  return {
    list: () => [...rules.values()],
    set: async (rule) => {
      const invalid = validateModeRoute(rule.route);
      if (invalid) throw new Error(`invalid_connector_mode: ${invalid}`);
      if (!isConnectorWriteMode(rule.mode)) {
        throw new Error(
          `invalid_connector_mode: mode must be ${CONNECTOR_WRITE_MODES.join(" | ")}`,
        );
      }
      const record: ConnectorModeRecord = { ...rule, at: now().toISOString() };
      rules.set(keyOf(rule.scope, rule.route), record);
      await opts.store?.saveConnectorMode(record);
      return record;
    },
    clear: async (scope, route) => {
      const existed = rules.delete(keyOf(scope, route));
      if (existed) await opts.store?.removeConnectorMode(scopeKey(scope), route);
      return existed;
    },
    resolve: (route, connectorId, subject) =>
      resolveWriteMode(route, connectorId, [...rules.values()], subject),
    // Errors propagate: a rule that failed to load reads as `auto`, which is
    // the widest setting there is, and the caller must be able to say so.
    hydrate: async () => {
      if (!opts.store) return 0;
      const loaded = await opts.store.loadConnectorModes();
      for (const record of loaded) rules.set(keyOf(record.scope, record.route), record);
      return loaded.length;
    },
  };
}

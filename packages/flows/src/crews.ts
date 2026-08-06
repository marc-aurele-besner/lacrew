/**
 * Crew blueprints — a vertical, written down.
 *
 * A design partner answers ten questions (`design-partner-intake.md`): what the
 * crew does, who reports to whom, what it may spend, where the line between
 * "just do it" and "ask me first" sits, and what must never happen. A blueprint
 * is that answer as data: the org chart, the per-seat caps and grants, the
 * escalation ladder, the constitutional changes, the guardrails — and, for each
 * guardrail, *which layer actually enforces it*.
 *
 * That last part is the point. It is easy to write a config that implies the
 * chain refuses something it has never seen. Every guardrail here names its
 * enforcement layer, and anything the protocol cannot prevent is either marked
 * `monitoring` (caught after the fact) or moved to `outOfScope` — so a partner
 * reading their own blueprint can tell a guarantee from a habit.
 *
 * Blueprints live in this package because a crew *is* its org shape plus the
 * flows it runs, and because this package stays free of chain dependencies:
 * a blueprint is portable JSON that the CLI, the cloud onboarding, and the
 * docs can all read without a wallet.
 */

import { getFlowTemplate } from "./templates.js";
import type { FlowDefinition, FlowStep } from "./types.js";

export type CrewVertical = "trading" | "dev" | "content" | "research" | "support" | "ops";

/**
 * Where a rule is actually enforced. Ordered loosely from hardest to softest —
 * the first four cannot be talked out of, the last two can.
 */
export type EnforcementLayer =
  /** A policy module: spend cap, whitelist, rate limit, time window. DENY is final. */
  | "policy"
  /** Allowance topology: leaves spend their own stream, never the treasury. */
  | "treasury"
  /** The session key's own limits — the key cannot sign it at all. */
  | "session"
  /** GovernanceModule: proposal, quorum, and (high tier) timelock + human veto. */
  | "governance"
  /** EscalationRouter: the action waits for a manager or the human root. */
  | "escalation"
  /** The flow's own routing. Real, but orchestrator-side — replaceable, not enforced onchain. */
  | "flow"
  /** A credential scoped outside LaCrew (a GitHub App, an API key, a draft-only token). */
  | "external"
  /** Detected after the fact by Guardian or the audit trail. Not prevention. */
  | "monitoring";

/** A place money can go. The whitelist is about payment targets, nothing else. */
export type CrewTarget = {
  id: string;
  label: string;
  /** What the money buys: a metered service, a trading venue, or a payout. */
  kind: "service" | "venue" | "payout";
  /**
   * Whether the org's whitelist admits this target at all. A `false` here is a
   * deliberate deny — the content crew's publish endpoint is off-whitelist so
   * that "publish" comes back DENY and lands in a human's lap by construction.
   *
   * The default policy stack whitelists org-wide, so this is an org-level
   * answer. Restricting a target to one seat needs `dedicatedPolicy` on it.
   */
  whitelisted: boolean;
  note: string;
};

/**
 * A credential the crew acts through that LaCrew does not govern. Naming these
 * is how a blueprint stays honest: the org chart bounds money, not repo access.
 */
export type CrewExternalScope = {
  id: string;
  label: string;
  /** Who enforces it (GitHub, the X API, the CMS) and how tightly it is cut. */
  boundary: string;
};

/** One seat in the org chart. */
export type CrewRole = {
  id: string;
  label: string;
  kind: "manager_agent" | "worker_agent";
  /** Role id of the manager, or "root" for the human root. */
  reportsTo: string;
  /** What this seat does, in the partner's terms. */
  charter: string;
  /** Per-call spend cap, USDC base units (6dp). SpendCapPolicy checks one call. */
  capUsdc: string;
  /** Per-epoch streaming allowance, USDC base units. The budget, as opposed to the cap. */
  grantUsdc: string;
  /**
   * Target ids this seat is expected to pay. Resolve against the blueprint's
   * targets — including targets marked `whitelisted: false`, which the seat
   * will attempt and be refused, because that refusal is the design.
   */
  spends: string[];
  /**
   * Why this seat needs its own policy stack rather than the org default.
   *
   * The default `WhitelistPolicy` is org-wide: a target allowed for one seat is
   * allowed for all of them. Separating "only the executor may touch a router"
   * takes a per-node stack bound through `EscalationRouter.setNodePolicy`, so a
   * seat that needs it says so here and the plan emits the binding step.
   */
  dedicatedPolicy?: string;
  /** MCP tools the seat expects wired. */
  tools: string[];
  /** Flow definition ids the seat runs. Must be flows the blueprint ships. */
  flows: string[];
};

/** One rung of the "ask me first" ladder from intake question 6. */
export type CrewEscalation = {
  /** The situation, in the partner's words. */
  when: string;
  /** Role id, or "human_root". */
  to: string;
  via: EnforcementLayer;
};

/** A change that is constitutional rather than operational (intake question 6, third bullet). */
export type CrewGovernanceRule = {
  change: string;
  /** High tier adds a timelock and a human veto; low tier is majority-instant. */
  tier: "low" | "high";
};

/** An answer to intake question 7 — "what must never happen" — and what stops it. */
export type CrewGuardrail = {
  never: string;
  enforcedBy: EnforcementLayer;
  /** The concrete mechanism. Vague entries here are how a config starts lying. */
  how: string;
  /** What the mechanism still does not cover. Present when the answer is partial. */
  residualRisk?: string;
};

/** A human seat. More than one means the org's high tier is genuinely shared. */
export type CrewHumanSeat = {
  id: string;
  label: string;
  holds: string;
};

/**
 * An external surface the crew's flows call, and the routes they need. The
 * operator registers these with the orchestrator (`LACREW_CONNECTORS`); a
 * blueprint declaring them is how they know what to wire before the crew can
 * do anything but think.
 */
export type CrewConnectorNeed = {
  /** Connector id a flow's tool names are prefixed with, e.g. `github`. */
  id: string;
  /** Route names used, without the prefix. */
  routes: string[];
  /**
   * Whether a shipped flow calls these routes today.
   *
   * `flow` — a flow in this blueprint names them, so the crew does not work
   * until the connector is registered. Validation holds both directions: a flow
   * may not call an undeclared route, and a `flow` need may not name routes no
   * flow calls.
   *
   * `operator` — the crew's pipeline stops short of this surface, and
   * registering it is how the operator closes that loop themselves. The studio
   * produces a package no shipped flow files to a CMS; the desk reasons about a
   * candidate it does not fetch. Saying so beats an empty list, which reads as
   * "this crew never leaves LaCrew" — and beats declaring it as `flow`, which
   * would send an operator to wire something nothing calls.
   *
   * Defaults to `flow`, so an omitted field cannot quietly weaken the check.
   */
  usedBy?: "flow" | "operator";
  /** What it is for, and which credential it wants. */
  note: string;
};

/**
 * A seat in **another** crew that this crew's flows may act on.
 *
 * A blueprint binds its own seats with `{{crew.<roleId>}}`, and validation
 * rejects a placeholder naming a seat it does not own — correctly, because the
 * blueprint has no idea what that role is or whether it exists. But a watchdog
 * whose whole job is to stop somebody else's executor has to name that account
 * somehow, and the shape it reached for was a run input: a free-form address,
 * checked by nobody, that the flow deactivates on sight.
 *
 * Declaring the reference is what makes it checkable. The blueprint says *which
 * seat of which crew* it expects — `{ crewBlueprintId: "defi-desk", roleId:
 * "executor" }` — and the address comes from resolving that against the crews
 * the workspace actually has (`resolveExternalSeats`). Nothing is typed, so
 * nothing can be mistyped; a reference that resolves to no seat, or to two,
 * binds nothing and stops the install rather than halting a plausible stranger.
 *
 * A declaration is not authority. Whoever installs this crew beside the desk is
 * the one handing over the ability to deactivate that seat, and the chain still
 * decides whether the deactivation lands.
 */
export type CrewExternalSeat = {
  /** Reference id, used in flows as `{{external.<id>}}`. */
  id: string;
  label: string;
  /**
   * Blueprint the sibling crew is expected to be installed from. Present when
   * the blueprint knows the shape of the crew it works beside, which is what
   * lets resolution refuse a seat that merely happens to share a role id.
   */
  crewBlueprintId?: string;
  /** Role id of the seat inside that crew. */
  roleId: string;
  /** What this crew will do with it, in the operator's terms. */
  authority: string;
};

export type CrewBlueprint = {
  id: string;
  name: string;
  vertical: CrewVertical;
  summary: string;
  /**
   * Where this blueprint's numbers come from.
   *
   * `file` names the filled design-partner intake they trace back to. Its
   * absence is meaningful and not an oversight: the blueprint is an
   * author-drafted pattern, and its caps and grants are a starting point
   * somebody reasoned about rather than a figure a real operator gave. A
   * surface that presented the two identically would lend partner-derived
   * authority to a guess.
   */
  intake: { persona: string; file?: string };
  /**
   * The cadence the grants are sized for. Epoch length is an operator decision
   * (EpochStreamer has no fixed period), so a blueprint has to state its own.
   */
  epoch: "day" | "week" | "month";
  /** The partner's stated all-in range (intake question 5), in whole USD. */
  budget: { monthlyUsdMin: number; monthlyUsdMax: number; note: string };
  humanSeats: CrewHumanSeat[];
  roles: CrewRole[];
  targets: CrewTarget[];
  /** Credentials the crew acts through that LaCrew does not govern. */
  externalScopes: CrewExternalScope[];
  /** Connectors the crew's flows call. Empty means the crew never leaves LaCrew. */
  connectors: CrewConnectorNeed[];
  /**
   * Seats in other crews this crew's flows act on, declared so the binding can
   * be resolved and checked instead of pasted. Omitted by every crew that only
   * ever touches its own org.
   */
  externalSeats?: CrewExternalSeat[];
  escalation: CrewEscalation[];
  governance: CrewGovernanceRule[];
  guardrails: CrewGuardrail[];
  /** Flow definition ids the crew ships with. */
  flows: string[];
  /** What this crew deliberately does not do, and what LaCrew cannot enforce for it. */
  outOfScope: string[];
  /**
   * The kind of thing this crew looks after, when it looks after anything.
   *
   * A blueprint cannot know *which* repos, venues or accounts belong to whoever
   * installs it, so it declares the noun and leaves the list to them. That is
   * the difference between an editor that prompts "add the repos this crew
   * watches" and one that shows an empty box with no clue what belongs in it.
   */
  caresFor?: {
    /** The noun, and the default kind for a row the operator adds. */
    kind: string;
    label: string;
    hint: string;
    /**
     * What one looks like, shown in the field.
     *
     * Carried per blueprint because the shape genuinely differs: "owner/repo"
     * is meaningless to a trading desk and a pool address is meaningless to a
     * maintainer. One placeholder across all of them asks every operator to
     * translate an example from somebody else's job.
     */
    placeholder: string;
    /** What the per-item note is for here — the part a generic list cannot carry. */
    notePlaceholder: string;
  };
};

/**
 * One layer of standing direction, mirroring `@lacrew/orchestrator`'s shape.
 *
 * Declared here rather than imported because `@lacrew/flows` does not depend on
 * the orchestrator — blueprints are data, and a data package that pulled in the
 * runtime to name a type would invert the dependency the packages are split on.
 */
export type BriefLayer = {
  label: string;
  text?: string;
  resources?: Array<{ kind: string; ref: string; note?: string }>;
  skills?: Array<{
    name: string;
    when?: string;
    instructions: string;
    /**
     * Set when a skill pack put this skill here (F2.23). Absent means a person
     * wrote it, which is what keeps an uninstall from taking their work with
     * it. Never rendered — it is provenance, not instruction.
     */
    source?: { pack: string; version: string; skill: string };
  }>;
};

export type CrewValidationResult = { ok: boolean; errors: string[] };

const EPOCHS_PER_MONTH: Record<CrewBlueprint["epoch"], number> = {
  day: 30,
  week: 4.345,
  month: 1,
};

function isBaseUnits(value: string | undefined): boolean {
  return typeof value === "string" && /^[0-9]+$/.test(value.trim()) && value.trim() !== "";
}

/**
 * Total streamed per month at this blueprint's epoch cadence, in whole USD.
 * The number a partner recognises: the sum of what the seats draw, not a cap.
 */
export function crewMonthlyGrantUsd(bp: CrewBlueprint): number {
  const perEpoch = bp.roles.reduce(
    (sum, r) => sum + (isBaseUnits(r.grantUsdc) ? Number(BigInt(r.grantUsdc)) / 1e6 : 0),
    0,
  );
  return Math.round(perEpoch * EPOCHS_PER_MONTH[bp.epoch]);
}

/**
 * What validation can check beyond the blueprint in front of it.
 *
 * An external seat names a role in *another* blueprint, and whether that role
 * exists is a fact about the catalog rather than about this document. Passing
 * the catalog turns "risk-watch expects defi-desk's executor" from prose into a
 * checked claim; omitting it leaves the reference structurally valid and
 * unresolved, which is what a caller holding one blueprint can honestly say.
 */
export type CrewValidationOptions = {
  /** Blueprints an external reference may name. Omitted skips that check. */
  crews?: readonly CrewBlueprint[];
};

/**
 * Structural validation. A blueprint that fails here would stand up an org whose
 * escalation ladder dead-ends, whose seats can pay targets nobody listed, or
 * whose flows do not exist — all of which surface as confusing chain reverts
 * long after the mistake was made.
 */
export function validateCrewBlueprint(
  bp: CrewBlueprint,
  options: CrewValidationOptions = {},
): CrewValidationResult {
  const errors: string[] = [];
  if (!bp.id?.trim()) errors.push("blueprint id is required");
  if (!bp.name?.trim()) errors.push("blueprint name is required");
  if (!bp.roles?.length) errors.push("blueprint needs at least one role");
  if (!bp.guardrails?.length) errors.push("blueprint needs at least one guardrail");
  if (!bp.humanSeats?.length) errors.push("blueprint needs at least one human seat");

  const roleById = new Map<string, CrewRole>();
  for (const role of bp.roles ?? []) {
    if (!role.id?.trim()) errors.push("every role needs an id");
    else if (roleById.has(role.id)) errors.push(`duplicate role id "${role.id}"`);
    else roleById.set(role.id, role);
    if (!isBaseUnits(role.capUsdc)) {
      errors.push(`role "${role.id}" cap must be USDC base units (got "${role.capUsdc}")`);
    }
    if (!isBaseUnits(role.grantUsdc)) {
      errors.push(`role "${role.id}" grant must be USDC base units (got "${role.grantUsdc}")`);
    }
    if (!role.charter?.trim()) errors.push(`role "${role.id}" needs a charter`);
  }

  const targetIds = new Set((bp.targets ?? []).map((t) => t.id));
  const spentTargets = new Set<string>();
  for (const role of bp.roles ?? []) {
    for (const target of role.spends ?? []) {
      if (!targetIds.has(target)) {
        errors.push(`role "${role.id}" spends on unknown target "${target}"`);
      }
      spentTargets.add(target);
    }
    for (const flowId of role.flows ?? []) {
      if (!bp.flows?.includes(flowId)) {
        errors.push(`role "${role.id}" runs flow "${flowId}" the blueprint does not ship`);
      }
    }
  }
  for (const target of bp.targets ?? []) {
    if (!spentTargets.has(target.id)) {
      errors.push(`target "${target.id}" is listed but no role spends on it`);
    }
  }

  for (const flowId of bp.flows ?? []) {
    if (!getFlowTemplate(flowId)) {
      errors.push(`blueprint ships flow "${flowId}" that is not a known template`);
    }
  }

  // Every external call a shipped flow makes has to be declared, or the
  // operator stands the crew up and discovers the gap at the first run.
  const declared = new Set(
    (bp.connectors ?? []).flatMap((c) => c.routes.map((r) => `${c.id}.${r}`)),
  );
  const called = new Set<string>();
  for (const flowId of bp.flows ?? []) {
    const def = getFlowTemplate(flowId)?.definition;
    for (const step of def?.steps ?? []) {
      if (step.kind !== "tool" || step.tool.startsWith("lacrew_")) continue;
      called.add(step.tool);
      if (!declared.has(step.tool)) {
        errors.push(`flow "${flowId}" calls "${step.tool}", which no declared connector serves`);
      }
    }
  }
  // And the other direction: a need marked as called by a flow, that no flow
  // calls, sends the operator to register a credential for nothing. The two
  // rules together are what keep `usedBy` honest as flows change.
  for (const need of bp.connectors ?? []) {
    if ((need.usedBy ?? "flow") !== "flow") continue;
    for (const route of need.routes) {
      if (!called.has(`${need.id}.${route}`)) {
        errors.push(
          `connector "${need.id}.${route}" is declared as called by a flow, but no shipped flow calls it (mark it usedBy: "operator" if the operator wires it themselves)`,
        );
      }
    }
  }

  // External seats: a reference to somebody else's crew has to be declared, and
  // a declaration has to be reachable. Held in both directions for the same
  // reason the connector rules are — an undeclared `{{external.*}}` renders as
  // an empty account at run time, and a declared reference nothing uses asks an
  // operator to hand over authority over a seat for no reason.
  const externalById = new Map<string, CrewExternalSeat>();
  for (const seat of bp.externalSeats ?? []) {
    if (!seat.id?.trim()) errors.push("every external seat needs an id");
    else if (externalById.has(seat.id)) errors.push(`duplicate external seat id "${seat.id}"`);
    else externalById.set(seat.id, seat);
    if (!seat.roleId?.trim()) errors.push(`external seat "${seat.id}" needs a role id`);
    if (!seat.label?.trim()) errors.push(`external seat "${seat.id}" needs a label`);
    // Without this the install form asks for authority over another crew's seat
    // and cannot say what it is for.
    if (!seat.authority?.trim()) {
      errors.push(`external seat "${seat.id}" must state what this crew does with it`);
    }
    if (seat.crewBlueprintId === bp.id) {
      errors.push(
        `external seat "${seat.id}" names this blueprint — a seat this crew owns binds as {{crew.${seat.roleId}}}`,
      );
    }
    // A reference nothing can resolve fails closed at install, which is a worse
    // place to learn that a role id was renamed in the sibling blueprint.
    const sibling = seat.crewBlueprintId
      ? options.crews?.find((c) => c.id === seat.crewBlueprintId)
      : undefined;
    if (seat.crewBlueprintId && options.crews && !sibling) {
      errors.push(`external seat "${seat.id}" names unknown blueprint "${seat.crewBlueprintId}"`);
    }
    if (sibling && !sibling.roles.some((r) => r.id === seat.roleId)) {
      errors.push(
        `external seat "${seat.id}" names role "${seat.roleId}", which "${sibling.id}" does not have`,
      );
    }
  }

  const externalUsed = new Set<string>();
  for (const flowId of bp.flows ?? []) {
    const def = getFlowTemplate(flowId)?.definition;
    if (!def) continue;
    for (const ref of crewFlowPlaceholders(def)) {
      const [kind, id] = ref.split(".") as [string, string];
      if (kind !== "external") continue;
      externalUsed.add(id);
      if (!externalById.has(id)) {
        errors.push(
          `flow "${flowId}" binds "{{external.${id}}}", which the blueprint does not declare as an external seat`,
        );
      }
    }
  }
  for (const seat of externalById.values()) {
    if (!externalUsed.has(seat.id)) {
      errors.push(`external seat "${seat.id}" is declared but no shipped flow binds it`);
    }
  }

  // Reporting lines: every seat reaches the human root, and only managers manage.
  for (const role of bp.roles ?? []) {
    if (role.reportsTo === "root") continue;
    const parent = roleById.get(role.reportsTo);
    if (!parent) {
      errors.push(`role "${role.id}" reports to unknown role "${role.reportsTo}"`);
      continue;
    }
    if (parent.kind !== "manager_agent") {
      errors.push(`role "${role.id}" reports to "${parent.id}", which is not a manager`);
    }
    // A manager whose own cap is lower than a report's cannot clear that
    // report's escalation without escalating again — the ladder dead-ends.
    if (
      isBaseUnits(parent.capUsdc) &&
      isBaseUnits(role.capUsdc) &&
      BigInt(parent.capUsdc) < BigInt(role.capUsdc)
    ) {
      errors.push(
        `role "${role.id}" cap exceeds its manager "${parent.id}" cap — escalations dead-end`,
      );
    }
  }

  for (const role of bp.roles ?? []) {
    const seen = new Set<string>([role.id]);
    let cursor = role.reportsTo;
    while (cursor !== "root" && roleById.has(cursor)) {
      if (seen.has(cursor)) {
        errors.push(`reporting cycle at role "${role.id}"`);
        break;
      }
      seen.add(cursor);
      cursor = roleById.get(cursor)!.reportsTo;
    }
  }

  for (const rung of bp.escalation ?? []) {
    if (rung.to !== "human_root" && !roleById.has(rung.to)) {
      errors.push(`escalation "${rung.when}" climbs to unknown role "${rung.to}"`);
    }
  }
  if (!(bp.escalation ?? []).some((r) => r.to === "human_root")) {
    errors.push("escalation ladder never reaches the human root");
  }

  // A guardrail whose enforcement is monitoring-only is fine — an unstated
  // residual risk on one is not, because the row reads as prevention.
  for (const rail of bp.guardrails ?? []) {
    if (!rail.how?.trim()) errors.push(`guardrail "${rail.never}" needs a mechanism`);
    if (rail.enforcedBy === "monitoring" && !rail.residualRisk?.trim()) {
      errors.push(`guardrail "${rail.never}" is monitoring-only and must state its residual risk`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------------- *
 * Binding: blueprint flows reference seats and targets by id, not address.
 * ------------------------------------------------------------------------- */

const PLACEHOLDER = /\{\{\s*(crew|target|external)\.([\w-]+)\s*\}\}/g;

/**
 * Whether a string still carries a reference an install was supposed to resolve.
 *
 * Its own non-global copy: `.test` on a `/g` regex carries `lastIndex` between
 * calls, and a matcher that answers differently the second time it is asked is
 * not one to guard an org action with.
 */
const UNBOUND = /\{\{\s*(crew|target|external)\.[\w-]+\s*\}\}/;

export function hasCrewPlaceholder(value: string): boolean {
  return UNBOUND.test(value);
}

/**
 * Placeholders a flow still needs bound, as `crew.<roleId>`,
 * `target.<targetId>` or `external.<refId>`.
 */
export function crewFlowPlaceholders(def: FlowDefinition): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(PLACEHOLDER)) found.add(`${m[1]}.${m[2]}`);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(def.steps);
  return [...found].sort();
}

export type CrewBindings = {
  /** Role id → the address the hire actually landed on. */
  roles?: Record<string, string>;
  /** Target id → the address money is sent to. */
  targets?: Record<string, string>;
  /** Role id → the policy stack deployed for a seat that needs its own. */
  policies?: Record<string, string>;
  /**
   * External seat id → the account of the sibling crew's seat it resolved to.
   * Produced by `resolveExternalSeats`, never typed in: the point of declaring
   * the reference is that the address is derived from a seat somebody hired.
   */
  external?: Record<string, string>;
};

/**
 * Resolve a crew flow's `{{crew.*}}` / `{{target.*}}` / `{{external.*}}`
 * placeholders to addresses.
 *
 * Throws on anything unbound rather than leaving the placeholder in place: the
 * run-time interpolator renders an unknown reference as an empty string, which
 * would turn "delegate to the risk manager" into "delegate to ''" at the worst
 * possible moment. Installation is where this must fail.
 */
export function bindCrewFlow(def: FlowDefinition, bindings: CrewBindings): FlowDefinition {
  const missing = new Set<string>();
  const resolve = (kind: string, id: string): string => {
    const table =
      kind === "crew" ? bindings.roles : kind === "external" ? bindings.external : bindings.targets;
    const hit = table?.[id];
    if (!hit) {
      missing.add(`${kind}.${id}`);
      return `{{${kind}.${id}}}`;
    }
    return hit;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(PLACEHOLDER, (_m, kind: string, id: string) => resolve(kind, id));
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  const bound: FlowDefinition = { ...def, steps: walk(def.steps) as FlowStep[] };
  if (missing.size > 0) {
    throw new Error(`unbound_crew_placeholders: ${[...missing].sort().join(", ")}`);
  }
  return bound;
}

/* ------------------------------------------------------------------------- *
 * Plan: the ordered work of standing a blueprint up.
 * ------------------------------------------------------------------------- */

export type CrewPlanStep = {
  order: number;
  kind: "hire" | "set-cap" | "bind-policy" | "whitelist" | "grant" | "install-flow";
  /**
   * How the step reaches the orchestrator: an MCP tool call, or its HTTP
   * surface. Flows are saved over `/flows`, not by an MCP tool, and a plan that
   * named a `lacrew_flow_*` tool would send an executor looking for one.
   */
  via: "mcp" | "http";
  /** The MCP tool name, or the HTTP route, that carries this step. */
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  /**
   * The governance tier this rides when policy escalates it. Hiring a manager
   * moves authority, so it rides high; a worker hire rides low.
   */
  tier?: "low" | "high";
  /** Bindings the step cannot be executed without: role and target addresses. */
  pending: string[];
  role?: string;
  target?: string;
  flow?: string;
};

/**
 * Turn a blueprint into the ordered calls that stand the crew up: hire down the
 * tree, cap each seat, bind any seat-specific policy stack, whitelist what the
 * crew may pay, fund the seats, install the flows.
 *
 * Whitelisting is emitted once per target rather than once per seat, because
 * the default `WhitelistPolicy` allows a target org-wide. Writing it per seat
 * would read as per-seat authority the chain does not grant.
 *
 * Nothing here executes. Each step carries the bindings it still needs, because
 * a hire's address only exists once the hire has landed — a plan generated
 * before that is a plan with holes, and it says so rather than inventing one.
 */
export function crewPlan(bp: CrewBlueprint, bindings: CrewBindings = {}): CrewPlanStep[] {
  const steps: CrewPlanStep[] = [];
  const roleAddr = (id: string): { value: string; pending: string[] } => {
    const hit = bindings.roles?.[id];
    return hit ? { value: hit, pending: [] } : { value: `{{crew.${id}}}`, pending: [`crew.${id}`] };
  };
  const targetAddr = (id: string): { value: string; pending: string[] } => {
    const hit = bindings.targets?.[id];
    return hit
      ? { value: hit, pending: [] }
      : { value: `{{target.${id}}}`, pending: [`target.${id}`] };
  };
  const policyAddr = (id: string): { value: string; pending: string[] } => {
    const hit = bindings.policies?.[id];
    return hit
      ? { value: hit, pending: [] }
      : { value: `{{policy.${id}}}`, pending: [`policy.${id}`] };
  };
  const push = (step: Omit<CrewPlanStep, "order">): void => {
    steps.push({ order: steps.length + 1, ...step });
  };

  // Managers before their reports, so every hire has a parent to attach to.
  // Declaration order is kept inside a level: the blueprint's own ordering is
  // how its author reads the crew, and a plan is read before it is run.
  const ordered: CrewRole[] = [];
  let remaining = [...bp.roles];
  let guard = remaining.length + 1;
  while (remaining.length > 0 && guard-- > 0) {
    const placeable = remaining.filter(
      (role) => role.reportsTo === "root" || ordered.some((r) => r.id === role.reportsTo),
    );
    if (placeable.length === 0) break;
    ordered.push(...placeable);
    remaining = remaining.filter((role) => !placeable.includes(role));
  }
  // A cycle would strand roles here; validation rejects those, so anything left
  // is appended rather than dropped — a plan must never silently lose a seat.
  ordered.push(...remaining);

  for (const role of ordered) {
    const parent = roleAddr(role.reportsTo === "root" ? "root" : role.reportsTo);
    push({
      kind: "hire",
      role: role.id,
      via: "mcp",
      tool: "lacrew_org_action",
      args: {
        action: "hire",
        label: role.label,
        parent: parent.value,
        nodeKind: role.kind,
      },
      summary: `Hire ${role.label} under ${role.reportsTo === "root" ? "the human root" : role.reportsTo}`,
      tier: role.kind === "manager_agent" ? "high" : "low",
      pending: parent.pending,
    });
  }

  for (const role of ordered) {
    const node = roleAddr(role.id);
    push({
      kind: "set-cap",
      role: role.id,
      via: "mcp",
      tool: "lacrew_org_action",
      args: { action: "set-cap", node: node.value, cap: role.capUsdc },
      summary: `Cap ${role.label} at ${formatUsdc(role.capUsdc)} per call`,
      tier: "high",
      pending: node.pending,
    });
    if (role.dedicatedPolicy) {
      const stack = policyAddr(role.id);
      push({
        kind: "bind-policy",
        role: role.id,
        via: "mcp",
        tool: "lacrew_org_action",
        args: { action: "set-policy", node: node.value, target: stack.value },
        summary: `Bind ${role.label} to its own policy stack — ${role.dedicatedPolicy}`,
        tier: "high",
        pending: [...node.pending, ...stack.pending],
      });
    }
    push({
      kind: "grant",
      role: role.id,
      via: "mcp",
      tool: "lacrew_set_budget",
      args: { action: "set-grant", node: node.value, amount: role.grantUsdc },
      summary: `Stream ${formatUsdc(role.grantUsdc)} per ${bp.epoch} to ${role.label}`,
      tier: "high",
      pending: node.pending,
    });
  }

  // One step per target: the org-wide whitelist is an org-wide decision, and a
  // seat that must be the only payer of a target gets there via its own stack.
  for (const target of bp.targets) {
    const addr = targetAddr(target.id);
    const payers = bp.roles.filter((r) => r.spends.includes(target.id)).map((r) => r.label);
    push({
      kind: "whitelist",
      target: target.id,
      via: "mcp",
      tool: "lacrew_org_action",
      args: {
        action: "set-whitelist",
        target: addr.value,
        allowed: target.whitelisted,
      },
      summary: target.whitelisted
        ? `Whitelist ${target.label} org-wide (paid by ${payers.join(", ")})`
        : `Leave ${target.label} off the whitelist — ${payers.join(", ")} will be denied by design`,
      tier: "high",
      pending: addr.pending,
    });
  }

  for (const flowId of bp.flows) {
    const def = getFlowTemplate(flowId)?.definition;
    const placeholders = def ? crewFlowPlaceholders(def) : [];
    const unbound = placeholders.filter((p) => {
      const [kind, id] = p.split(".") as [string, string];
      const table =
        kind === "crew"
          ? bindings.roles
          : kind === "external"
            ? bindings.external
            : bindings.targets;
      return !table?.[id];
    });
    push({
      kind: "install-flow",
      flow: flowId,
      via: "http",
      tool: "POST /flows",
      args: { id: flowId },
      summary: `Install flow "${def?.name ?? flowId}"${
        placeholders.length > 0
          ? ` (binds ${placeholders.length} reference${placeholders.length === 1 ? "" : "s"})`
          : ""
      }`,
      pending: unbound,
    });
  }

  return steps;
}

/** USDC base units as a readable amount — plans are read by humans. */
export function formatUsdc(baseUnits: string): string {
  if (!isBaseUnits(baseUnits)) return `${baseUnits} USDC`;
  const units = BigInt(baseUnits);
  const whole = units / 1_000_000n;
  const frac = units % 1_000_000n;
  const fracStr = frac === 0n ? "" : `.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
  return `${whole}${fracStr} USDC`;
}

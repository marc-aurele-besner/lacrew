import { isValidCron } from "./cron.js";
import type {
  AgentStep,
  BranchStep,
  BudgetStep,
  FlowDefinition,
  FlowStep,
  GateStep,
  GovernanceStep,
  OrgStep,
  SwitchStep,
} from "./types.js";

export type FlowValidationResult = { ok: boolean; errors: string[] };

export const STEP_KINDS = [
  "model",
  "tool",
  "gate",
  "branch",
  "switch",
  "agent",
  "org",
  "budget",
  "governance",
] as const;

export const SCOPE_LEVELS = ["org", "team", "agent"] as const;

export const ORG_ACTIONS = [
  "hire",
  "fire",
  "reparent",
  "activate",
  "deactivate",
  "set-cap",
  "set-whitelist",
  "set-policy",
] as const;

export const BUDGET_ACTIONS = ["set-grant", "stream-allowance", "run-epoch"] as const;

export const GOVERNANCE_ACTIONS = ["propose", "vote", "veto", "execute"] as const;

/** Addresses arrive from builders and marketplace JSON, so shape-check them. */
function looksLikeAddress(value: string | undefined): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/** Interpolated fields resolve at run time, so `{{…}}` passes the address check. */
function isInterpolated(value: string | undefined): boolean {
  return typeof value === "string" && value.includes("{{");
}

function requireAddress(
  errors: string[],
  value: string | undefined,
  what: string,
): void {
  if (!value?.trim()) {
    errors.push(`${what} is required`);
  } else if (!isInterpolated(value) && !looksLikeAddress(value)) {
    errors.push(`${what} must be a 0x address (got "${value}")`);
  }
}

/**
 * All outgoing edges of a step (undefined = fall-through, null = stop).
 * Unknown kinds have no edges: flows arrive as JSON from builders and
 * marketplace listings, so the type union is not a runtime guarantee.
 */
export function stepEdges(step: FlowStep): Array<string | null | undefined> {
  switch (step.kind) {
    case "model":
    case "tool":
    case "agent":
    case "governance":
      return [step.next];
    case "gate":
    case "org":
    case "budget":
      return [step.onAllow, step.onEscalate, step.onDeny];
    case "branch":
      return [step.onTrue, step.onFalse];
    case "switch":
      return [...step.cases.map((c) => c.next), step.onDefault];
    default:
      return [];
  }
}

/**
 * Structural validation: unique ids, resolvable edges, existing entry, and no
 * cycles — flows are pipelines; recurrence belongs to the epoch/queue layer.
 */
export function validateFlow(def: FlowDefinition): FlowValidationResult {
  const errors: string[] = [];
  if (!def.id?.trim()) errors.push("flow id is required");
  if (!def.name?.trim()) errors.push("flow name is required");
  if (!def.steps?.length) errors.push("flow needs at least one step");
  if (
    def.trigger !== undefined &&
    def.trigger !== "manual" &&
    def.trigger !== "epoch" &&
    def.trigger !== "cron"
  ) {
    errors.push(`unknown trigger "${def.trigger}" (manual | epoch | cron)`);
  }
  if (def.trigger === "cron" && !isValidCron(def.schedule ?? "")) {
    errors.push(
      `cron trigger needs a valid 5-field schedule (got "${def.schedule ?? ""}")`,
    );
  }
  if (def.scope) {
    const level = def.scope.level;
    if (!SCOPE_LEVELS.includes(level)) {
      errors.push(`unknown scope level "${level}" (${SCOPE_LEVELS.join(" | ")})`);
    } else if (level !== "org") {
      requireAddress(errors, def.scope.ref, `scope.ref for a "${level}"-scoped flow`);
    }
  }

  const ids = new Set<string>();
  for (const step of def.steps ?? []) {
    if (!step.id?.trim()) errors.push("every step needs an id");
    else if (ids.has(step.id)) errors.push(`duplicate step id "${step.id}"`);
    else ids.add(step.id);
    if (!STEP_KINDS.includes(step.kind as (typeof STEP_KINDS)[number])) {
      errors.push(
        `step "${step.id}" has unknown kind "${step.kind}" (${STEP_KINDS.join(" | ")})`,
      );
    }
    if (step.kind === "model" && !step.prompt?.trim()) {
      errors.push(`model step "${step.id}" needs a prompt`);
    }
    if (step.kind === "tool" && !step.tool?.trim()) {
      errors.push(`tool step "${step.id}" needs a tool name`);
    }
    if (step.kind === "gate" && !(step as GateStep).value?.trim()) {
      errors.push(`gate step "${step.id}" needs a value`);
    }
    if (step.kind === "branch" && !(step as BranchStep).when?.source?.trim()) {
      errors.push(`branch step "${step.id}" needs a when.source`);
    }
    if (step.kind === "switch") {
      const sw = step as SwitchStep;
      if (!sw.when?.source?.trim()) {
        errors.push(`switch step "${step.id}" needs a when.source`);
      }
      if (!Array.isArray(sw.cases) || sw.cases.length === 0) {
        errors.push(`switch step "${step.id}" needs at least one case`);
      } else {
        sw.cases.forEach((c, i) => {
          if (!c.value?.trim()) {
            errors.push(`switch step "${step.id}" case ${i} needs a value`);
          }
        });
      }
    }
    if (step.kind === "agent") {
      const ag = step as AgentStep;
      if (ag.action !== "invoke") {
        errors.push(`agent step "${step.id}" has unknown action "${ag.action}" (invoke)`);
      }
      requireAddress(errors, ag.agent, `agent step "${step.id}" agent`);
      if (!ag.prompt?.trim() && !ag.flowId?.trim()) {
        errors.push(`agent step "${step.id}" needs a prompt or a flowId`);
      }
    }
    if (step.kind === "org") {
      const og = step as OrgStep;
      if (!ORG_ACTIONS.includes(og.action)) {
        errors.push(
          `org step "${step.id}" has unknown action "${og.action}" (${ORG_ACTIONS.join(" | ")})`,
        );
      }
      // "hire" mints a new account from a label; every other action targets one.
      if (og.action === "hire") {
        if (!og.label?.trim()) errors.push(`org step "${step.id}" needs a label to hire`);
        requireAddress(errors, og.parent, `org step "${step.id}" parent`);
        if (og.nodeKind !== "manager_agent" && og.nodeKind !== "worker_agent") {
          errors.push(
            `org step "${step.id}" needs nodeKind manager_agent | worker_agent to hire`,
          );
        }
      } else {
        requireAddress(errors, og.node, `org step "${step.id}" node`);
      }
      if (og.action === "reparent") {
        requireAddress(errors, og.parent, `org step "${step.id}" parent`);
      }
      if (og.action === "set-cap" && !og.cap?.trim()) {
        errors.push(`org step "${step.id}" needs a cap`);
      }
      if (og.action === "set-whitelist") {
        requireAddress(errors, og.target, `org step "${step.id}" target`);
      }
      if (og.action === "set-policy") {
        requireAddress(errors, og.target, `org step "${step.id}" policy module`);
      }
    }
    if (step.kind === "budget") {
      const bg = step as BudgetStep;
      if (!BUDGET_ACTIONS.includes(bg.action)) {
        errors.push(
          `budget step "${step.id}" has unknown action "${bg.action}" (${BUDGET_ACTIONS.join(" | ")})`,
        );
      } else if (bg.action !== "run-epoch") {
        requireAddress(errors, bg.node, `budget step "${step.id}" node`);
        if (!bg.amount?.trim()) errors.push(`budget step "${step.id}" needs an amount`);
      }
    }
    if (step.kind === "governance") {
      const gv = step as GovernanceStep;
      if (!GOVERNANCE_ACTIONS.includes(gv.action)) {
        errors.push(
          `governance step "${step.id}" has unknown action "${gv.action}" (${GOVERNANCE_ACTIONS.join(" | ")})`,
        );
      } else if (gv.action === "propose") {
        requireAddress(errors, gv.target, `governance step "${step.id}" target`);
      } else if (!gv.proposalId?.trim()) {
        errors.push(`governance step "${step.id}" needs a proposalId to ${gv.action}`);
      }
    }
  }

  const entry = def.entry ?? def.steps?.[0]?.id;
  if (entry && !ids.has(entry)) errors.push(`entry step "${entry}" does not exist`);

  for (const step of def.steps ?? []) {
    for (const edge of stepEdges(step)) {
      if (typeof edge === "string" && !ids.has(edge)) {
        errors.push(`step "${step.id}" points to unknown step "${edge}"`);
      }
    }
  }

  if (errors.length === 0 && entry) {
    const cycle = findCycle(def, entry);
    if (cycle) errors.push(`cycle detected: ${cycle.join(" → ")}`);
  }

  return { ok: errors.length === 0, errors };
}

/** Resolve a step's fall-through target: the next declared step, else stop. */
export function fallThrough(def: FlowDefinition, stepId: string): string | null {
  const idx = def.steps.findIndex((s) => s.id === stepId);
  if (idx < 0 || idx + 1 >= def.steps.length) return null;
  return def.steps[idx + 1]?.id ?? null;
}

function findCycle(def: FlowDefinition, entry: string): string[] | null {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (done.has(id)) return null;
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    visiting.add(id);
    path.push(id);
    const step = byId.get(id);
    if (step) {
      for (const edge of stepEdges(step)) {
        const target = edge === undefined ? fallThrough(def, id) : edge;
        if (typeof target === "string") {
          const cycle = visit(target);
          if (cycle) return cycle;
        }
      }
    }
    visiting.delete(id);
    path.pop();
    done.add(id);
    return null;
  };

  return visit(entry);
}

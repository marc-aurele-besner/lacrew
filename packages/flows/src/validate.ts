import type { BranchStep, FlowDefinition, FlowStep, GateStep } from "./types.js";

export type FlowValidationResult = { ok: boolean; errors: string[] };

/** All outgoing edges of a step (undefined = fall-through, null = stop). */
export function stepEdges(step: FlowStep): Array<string | null | undefined> {
  switch (step.kind) {
    case "model":
    case "tool":
      return [step.next];
    case "gate":
      return [step.onAllow, step.onEscalate, step.onDeny];
    case "branch":
      return [step.onTrue, step.onFalse];
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

  const ids = new Set<string>();
  for (const step of def.steps ?? []) {
    if (!step.id?.trim()) errors.push("every step needs an id");
    else if (ids.has(step.id)) errors.push(`duplicate step id "${step.id}"`);
    else ids.add(step.id);
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

/**
 * Deploy-and-bind planning: match a node's requested stack against what the
 * chain already binds for it, so identical modules are reused instead of
 * redeployed and an unchanged composition proposes nothing at all.
 *
 * Reuse is param-exact and scoped to the node's own current stack — the one
 * set of modules whose bindings this submission is allowed to reason about.
 * A near-match never reuses: "10/h" and "10/d" are different limits, and
 * silently substituting one for the other would enforce something nobody
 * drafted.
 */

import type { NodePolicyStack, PolicyModuleInfo } from "@lacrew/core";
import type { NodeStackModuleSpec } from "./runtime.js";

export type PlannedModule = {
  spec: NodeStackModuleSpec;
  /** Address of an identical already-deployed module to reuse, when found. */
  reuse?: `0x${string}`;
};

/** Whether a chain-read module is param-identical to a requested spec. */
export function moduleMatchesSpec(spec: NodeStackModuleSpec, m: PolicyModuleInfo): boolean {
  switch (spec.kind) {
    case "rate_limit":
      return (
        m.kind === "rate_limit" &&
        m.maxActions === spec.maxActions &&
        m.windowSeconds === spec.windowSeconds
      );
    case "time_window":
      return (
        m.kind === "time_window" &&
        m.startSecondOfDay === spec.startSecondOfDay &&
        m.endSecondOfDay === spec.endSecondOfDay
      );
    default:
      // Whitelist / spend-cap ride the org's shared modules from the address
      // book; they are never deployed here, so there is nothing to reuse.
      return false;
  }
}

/**
 * Plan each requested module: reuse the node's current identical module where
 * one exists (each at most once — two "5/d" specs need two modules), deploy
 * otherwise.
 */
export function planNodeStack(
  specs: NodeStackModuleSpec[],
  current: NodePolicyStack | undefined,
): PlannedModule[] {
  const mods = current?.modules ?? [];
  const used = new Set<number>();
  return specs.map((spec) => {
    const idx = mods.findIndex((m, i) => !used.has(i) && moduleMatchesSpec(spec, m));
    if (idx >= 0) {
      used.add(idx);
      return { spec, reuse: mods[idx]!.address };
    }
    return { spec };
  });
}

/**
 * Whether the resolved member list is exactly the node's currently bound
 * stack — same modules, same order, bound per-node (an inherited default with
 * the same composition still deserves an explicit binding, since that is what
 * the operator asked to exist). Nested stacks bail to "changed": their
 * flattening is a display concern, not an identity this check can trust.
 */
export function stackUnchanged(
  members: `0x${string}`[],
  current: NodePolicyStack | undefined,
): boolean {
  if (!current || current.source !== "node") return false;
  const mods = current.modules;
  if (mods.some((m) => m.kind === "stack")) return false;
  if (mods.length !== members.length) return false;
  return members.every((addr, i) => addr.toLowerCase() === mods[i]!.address.toLowerCase());
}

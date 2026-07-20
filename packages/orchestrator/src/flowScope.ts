/**
 * Flow scope resolution: who may see and invoke a flow, and what policy
 * ceiling its runs are capped at.
 *
 * A flow's scope is a publication rule over the org chart, not an identity —
 * runs always execute as the invoking principal. Scope adds a second policy
 * stack the run is also checked against, so the effective authority of a run is
 * `min(principal, scope)`. This ceiling is enforced here, off-chain; the chain
 * still enforces the principal's own stack independently. A compromised
 * orchestrator can therefore ignore the ceiling but never the principal's
 * policy, which is the invariant that actually protects the treasury.
 */

import type { FlowDefinition, FlowScope, Verdict } from "@lacrew/flows";
import type { OrgNode } from "@lacrew/core";

const VERDICT_RANK: Record<Verdict, number> = { ALLOW: 0, ESCALATE: 1, DENY: 2 };

/** The stricter of two verdicts — the PolicyStack rule applied across stacks. */
export function worstVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

export function normalizeVerdict(raw: unknown): Verdict {
  const s = String(raw ?? "").toUpperCase();
  // An unreadable verdict is never approval.
  return s === "ALLOW" || s === "DENY" ? s : "ESCALATE";
}

/** Flows without an explicit scope are published org-wide. */
export function scopeOf(def: FlowDefinition): FlowScope {
  return def.scope ?? { level: "org" };
}

const same = (a?: string, b?: string): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Every node at or below `root`, following the org chart's parent pointers. */
export function subtreeOf(nodes: OrgNode[], root: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes) {
    const parent = node.parent?.toLowerCase();
    if (!parent) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(node.account.toLowerCase());
    childrenOf.set(parent, list);
  }

  const out = new Set<string>();
  const stack = [root.toLowerCase()];
  while (stack.length) {
    const current = stack.pop()!;
    if (out.has(current)) continue;
    out.add(current);
    stack.push(...(childrenOf.get(current) ?? []));
  }
  return out;
}

/** Walk from `agent` to the root, collecting its managers. */
export function ancestorsOf(nodes: OrgNode[], agent: string): Set<string> {
  const byAccount = new Map(nodes.map((n) => [n.account.toLowerCase(), n]));
  const out = new Set<string>();
  let current = byAccount.get(agent.toLowerCase())?.parent?.toLowerCase();
  while (current && !out.has(current)) {
    out.add(current);
    current = byAccount.get(current)?.parent?.toLowerCase();
  }
  return out;
}

/**
 * May `agent` see and invoke this flow?
 * - org   — anyone in the org.
 * - team  — the scoped node and its descendants.
 * - agent — the scoped agent, plus its managers (who may inspect and run it).
 *
 * An empty org tree means the runtime cannot resolve the chart (mock mode, or
 * no registry configured), so scoping cannot be evaluated and everything is
 * visible. Callers that need a hard boundary must supply a real tree.
 */
export function visibleTo(
  def: FlowDefinition,
  agent: string,
  nodes: OrgNode[],
): boolean {
  const scope = scopeOf(def);
  if (scope.level === "org") return true;
  if (!scope.ref) return true;
  if (same(scope.ref, agent)) return true;
  if (nodes.length === 0) return true;

  if (scope.level === "team") {
    return subtreeOf(nodes, scope.ref).has(agent.toLowerCase());
  }
  return ancestorsOf(nodes, scope.ref).has(agent.toLowerCase());
}

/**
 * The agent whose policy stack caps this flow's runs, or undefined for an
 * org-scoped flow (no additional ceiling beyond the principal's own).
 */
export function ceilingAgent(def: FlowDefinition): `0x${string}` | undefined {
  const scope = scopeOf(def);
  if (scope.level === "org" || !scope.ref) return undefined;
  return scope.ref as `0x${string}`;
}

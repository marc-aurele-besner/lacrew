/**
 * The mapping a blueprint install learns and the chain cannot hold: which
 * account each blueprint seat landed on (PRD F2.25).
 *
 * `OrgRegistry.Node` is `{account, kind, parent, active}`. The protocol has no
 * notion of a "reviewer", so the only way to find that seat again is something
 * off-chain holding `reviewer → 0x…`. The hosted control plane keeps one per
 * tenant; a self-host kept none, which is why `crews checklist --bind` had to
 * carry the mapping from the plan file the operator installed from — a file
 * that is easy to lose and, once lost, takes every renamed seat with it.
 *
 * This module is the vocabulary both sides use for that record: what a binding
 * is, how it is keyed, and how it is layered over a served node list. It is
 * pure, so the orchestrator can persist it, the cloud can dual-write it, and
 * `resolveCrewSeats` can go on being the one place that decides which seat a
 * flow runs as.
 *
 * ## Not authority
 *
 * A stored role id *finds* a seat. It admits nothing, budgets nothing and
 * proves nothing about whether the seat can work — the checklist still derives
 * that from live reads. Renaming a seat changes the string a human reads and
 * nothing else, which is exactly why the id has to be stored beside the label
 * rather than recovered from it.
 */

/** Blueprint role id → the account its hire minted, and where it came from. */
export type CrewRoleBinding = {
  /** Blueprint role id, e.g. `pr-triager`. */
  roleId: string;
  /** The account the hire landed on, lowercased. */
  account: string;
  /**
   * The seat's label when the binding was written. A breadcrumb for an
   * operator reading the list back, never used to resolve anything — the whole
   * point of the id is that the label is free to change.
   */
  label?: string;
  /** Blueprint the role id belongs to, when the writer knew it. */
  blueprintId?: string;
  /** Crew the seat belongs to, when the writer groups seats into crews. */
  crewId?: string;
  at: string;
};

export type CrewRoleBindingInput = {
  roleId: string;
  account: string;
  label?: string;
  blueprintId?: string;
  crewId?: string;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Which set of role ids a binding belongs to.
 *
 * A crew id when the writer has one, the blueprint id when it does not, and
 * `workspace` when it knows neither. Two crews installed from the same
 * blueprint both have a `reviewer`, and flattening them into one key would let
 * the second install silently rebind the first one's seat.
 */
export function crewBindingScope(binding: {
  crewId?: string | null;
  blueprintId?: string | null;
}): string {
  const crew = binding.crewId?.trim();
  if (crew) return `crew:${crew.toLowerCase()}`;
  const bp = binding.blueprintId?.trim();
  if (bp) return `blueprint:${bp.toLowerCase()}`;
  return "workspace";
}

/** Stable identity of one binding: its scope and its role id. */
export function crewBindingKey(binding: {
  roleId: string;
  crewId?: string | null;
  blueprintId?: string | null;
}): string {
  return `${crewBindingScope(binding)}|${binding.roleId.trim()}`;
}

/**
 * Validate and canonicalize one binding.
 *
 * Throws rather than storing something unusable: a binding is read back into an
 * address a flow runs as, and a stored typo binds a run to nothing — or, worse,
 * to a plausible wrong principal under the wrong policy stack.
 */
export function normalizeCrewBinding(input: CrewRoleBindingInput, at: string): CrewRoleBinding {
  const roleId = input.roleId?.trim();
  if (!roleId) throw new Error("crew_binding_role_required");
  const account = input.account?.trim();
  if (!account || !ADDRESS.test(account)) throw new Error("crew_binding_account_invalid");
  const label = input.label?.trim();
  const blueprintId = input.blueprintId?.trim();
  const crewId = input.crewId?.trim();
  return {
    roleId,
    account: account.toLowerCase(),
    ...(label ? { label } : {}),
    ...(blueprintId ? { blueprintId } : {}),
    ...(crewId ? { crewId } : {}),
    at,
  };
}

/**
 * Role id → account for one scope, in the shape `bindCrewFlow` takes as
 * `roles`. Bindings from other scopes are left out rather than blended in: a
 * `reviewer` on another crew is not this crew's reviewer.
 */
export function crewBindingRoles(
  bindings: readonly CrewRoleBinding[],
  scope?: { crewId?: string | null; blueprintId?: string | null },
): Record<string, string> {
  const wanted = scope ? crewBindingScope(scope) : null;
  const out: Record<string, string> = {};
  for (const binding of bindings) {
    if (wanted && crewBindingScope(binding) !== wanted) continue;
    out[binding.roleId] = binding.account;
  }
  return out;
}

/**
 * Layer stored role ids over a served node list.
 *
 * Nodes keep every other field; only `roleId` is added, and only where a
 * binding names the account. A node nothing bound is served exactly as it
 * arrived, so a seat hired before any of this existed still resolves by its
 * label — and a node that already carries an id keeps it, because the surface
 * that put it there knew something this list does not.
 */
export function applyCrewRoleIds<T extends { account?: string | null; roleId?: string | null }>(
  nodes: readonly T[],
  bindings: readonly CrewRoleBinding[],
): T[] {
  if (bindings.length === 0) return [...nodes];
  const byAccount = new Map<string, string>();
  for (const binding of bindings) {
    if (!byAccount.has(binding.account)) byAccount.set(binding.account, binding.roleId);
  }
  return nodes.map((node) => {
    if (!node.account || node.roleId) return node;
    const roleId = byAccount.get(node.account.trim().toLowerCase());
    return roleId ? { ...node, roleId } : node;
  });
}

/**
 * Role ids two records both name and disagree about.
 *
 * Two stores holding the same mapping is a drift risk, not a redundancy: the
 * one that is wrong binds a flow to the wrong principal, and nothing about a
 * silent disagreement says which one that is. A caller that finds any of these
 * has to say so out loud and name its source of truth.
 */
export function crewBindingConflicts(
  ours: Record<string, string>,
  theirs: Record<string, string>,
): Array<{ roleId: string; ours: string; theirs: string }> {
  const out: Array<{ roleId: string; ours: string; theirs: string }> = [];
  for (const [roleId, account] of Object.entries(ours)) {
    const other = theirs[roleId];
    if (!other) continue;
    if (other.trim().toLowerCase() !== account.trim().toLowerCase()) {
      out.push({ roleId, ours: account, theirs: other });
    }
  }
  return out.sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0));
}

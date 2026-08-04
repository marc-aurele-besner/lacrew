/**
 * Which account a blueprint seat landed on.
 *
 * A blueprint's flows name seats by role id (`{{crew.pr-triager}}`); the chain
 * stores addresses and reporting lines and has no idea what a "role id" is. So
 * something off-chain has to hold the mapping, and for a long time nothing did:
 * a seat was found by matching the label an operator typed against the
 * blueprint role's own label, which works exactly until somebody renames the
 * seat — after which the install, the checklist and the sample run all stop
 * finding a principal that is sitting right there.
 *
 * This resolves both ways and says which one answered:
 *
 * 1. **A persisted role id wins.** A surface that recorded `pr-triager → 0x…`
 *    at install time keeps binding correctly through any number of renames,
 *    because a rename touches the display string and nothing else.
 * 2. **A label match is the fallback**, for seats hired before anything stored
 *    role ids and for crews stood up by hand. It is reported as a label match
 *    rather than silently blended in, so a caller can persist what it learned
 *    and stop depending on the label.
 *
 * Two rules keep the fallback from binding the wrong address:
 *
 * - An account already bound to one role cannot also answer for another.
 * - A label that matches **two** seats binds neither. A plausible-looking wrong
 *   address is worse than an unbound one: unbound stops the install and names
 *   the seat, wrong runs a flow as the wrong principal under the wrong policy
 *   stack.
 */

import type { CrewBlueprint } from "./crews.js";

/**
 * A node as an org surface serves it. Every field is optional because this has
 * to read the org chart of a workspace that has persisted nothing yet.
 */
export type CrewSeatNode = {
  account?: string | null;
  label?: string | null;
  /** `HumanRoot` / `ManagerAgent` / `WorkerAgent`, however the surface spells it. */
  kind?: string | null;
  /** Blueprint role id recorded when the hire landed, when a surface stores one. */
  roleId?: string | null;
};

export type CrewSeatBinding = {
  /** Blueprint role id. */
  role: string;
  account: string;
  /** How it was found. A label match is the one that a rename breaks. */
  boundBy: "role-id" | "label";
};

export type CrewSeatResolution = {
  /** Role id → account, in the shape `bindCrewFlow` takes as `roles`. */
  roles: Record<string, string>;
  bindings: CrewSeatBinding[];
  /** Role ids nothing answered for, sorted. */
  missing: string[];
  /**
   * Role ids whose only candidate was ambiguous — more than one seat carries
   * that label — so nothing was bound. Also present in `missing`: the caller's
   * job is the same (do not install), the distinction is what to tell a human.
   */
  ambiguous: string[];
  /**
   * Bindings a persisted role id made that a label match could not have: the
   * seat has since been renamed. Evidence that persisting role ids is doing
   * work, and the line a surface shows instead of reporting a missing seat.
   */
  renamed: CrewSeatBinding[];
};

const key = (s: string): string => s.trim().toLowerCase();

function isHuman(kind: string | null | undefined): boolean {
  return (kind ?? "").toLowerCase().includes("human");
}

/**
 * Resolve every seat of a blueprint against a served node list.
 *
 * `root` is bound to the workspace's human seat when one is present, since a
 * blueprint never hires the root but its plans and flows may name it.
 */
export function resolveCrewSeats(
  bp: CrewBlueprint,
  nodes: readonly CrewSeatNode[],
): CrewSeatResolution {
  const roles: Record<string, string> = {};
  const bindings: CrewSeatBinding[] = [];
  const ambiguous: string[] = [];
  const renamed: CrewSeatBinding[] = [];
  const taken = new Set<string>();

  const root = nodes.find((n) => isHuman(n.kind) && n.account);
  if (root?.account) {
    roles.root = root.account;
    taken.add(key(root.account));
  }

  const byRole = new Map<string, CrewSeatNode>();
  for (const node of nodes) {
    const id = node.roleId?.trim();
    if (!id || !node.account) continue;
    if (!byRole.has(id)) byRole.set(id, node);
  }

  for (const role of bp.roles) {
    const stored = byRole.get(role.id);
    if (stored?.account && !taken.has(key(stored.account))) {
      const binding: CrewSeatBinding = {
        role: role.id,
        account: stored.account,
        boundBy: "role-id",
      };
      roles[role.id] = stored.account;
      bindings.push(binding);
      taken.add(key(stored.account));
      // The label has drifted from the blueprint's, so nothing but the stored
      // id could have found this seat.
      if (key(stored.label ?? "") !== key(role.label)) renamed.push(binding);
      continue;
    }

    const matches = nodes.filter(
      (n) => n.account && !taken.has(key(n.account)) && key(n.label ?? "") === key(role.label),
    );
    if (matches.length > 1) {
      ambiguous.push(role.id);
      continue;
    }
    const hit = matches[0];
    if (hit?.account) {
      roles[role.id] = hit.account;
      bindings.push({ role: role.id, account: hit.account, boundBy: "label" });
      taken.add(key(hit.account));
    }
  }

  const missing = bp.roles
    .filter((r) => !roles[r.id])
    .map((r) => r.id)
    .sort();
  return { roles, bindings, missing, ambiguous: ambiguous.sort(), renamed };
}

/**
 * Role id → account for the seats a surface should persist.
 *
 * A caller that just installed a crew knows the mapping first-hand and should
 * write it; a caller that resolved by label learned something a rename will
 * take away, and writing it now is what makes the next read survive.
 */
export function seatRoleMap(resolution: CrewSeatResolution): Record<string, string> {
  return Object.fromEntries(resolution.bindings.map((b) => [b.role, b.account]));
}

/**
 * Binding a seat this crew does not own (PRD F2.13).
 *
 * `resolveCrewSeats` answers "which account is *our* reviewer". This answers the
 * other question a watchdog has to ask: "which account is the desk's executor" —
 * a seat in a sibling crew, hired by somebody else, that this crew's flows may
 * deactivate.
 *
 * ## Why not a run input
 *
 * Because a run input is an address a human pastes, and nothing about it says it
 * is the account anybody meant. The risk crew's claim — "we can halt the seat
 * trading the protocol we just flagged" — was only ever as good as that paste.
 * Deactivating the wrong node is not a near miss: it stops a crew that was
 * working and leaves the one that was not.
 *
 * ## What resolution is allowed to do
 *
 * Look up seats the workspace already knows: role id, the blueprint the crew was
 * installed from, and the account its hire landed on. That is the same record
 * that finds `{{crew.*}}`, read across crews instead of within one.
 *
 * What it may never do is guess. Three ways this refuses:
 *
 * - **Nothing matched** — the sibling crew is not installed, or its seat has
 *   never landed. Unbound, and the install says which reference and why.
 * - **More than one matched** — two crews from the same blueprint both have an
 *   `executor`. Unbound: a coin flip between two live crews is worse than a
 *   blocker, and picking one is a decision only the operator can make (they make
 *   it by naming the crew, which narrows the candidates to one).
 * - **The blueprint disagrees** — the reference names `defi-desk`'s executor and
 *   the only candidate came from some other blueprint. Not a match; a role id
 *   that happens to collide is not the seat this crew was pointed at.
 */

import type { CrewBlueprint, CrewExternalSeat } from "./crews.js";

/**
 * A seat some crew in the workspace holds, as the surface that stores role ids
 * serves it: the orchestrator's own bindings, or the control plane's install
 * record. Everything but the two identifying fields is optional, because a
 * workspace that has persisted little still deserves an answer.
 */
export type CrewExternalCandidate = {
  /** Blueprint role id this account was hired as. */
  roleId: string;
  account: string;
  /** Blueprint the crew was installed from, when the writer recorded one. */
  blueprintId?: string | null;
  /** The crew instance the seat belongs to, when there is one. */
  crewId?: string | null;
  /** The seat's label, for a picker. Never used to resolve anything. */
  label?: string | null;
};

export type CrewExternalBinding = {
  /** External seat id, as flows name it: `{{external.<ref>}}`. */
  ref: string;
  account: string;
  crewId?: string;
  blueprintId?: string;
};

export type CrewExternalResolution = {
  /** Ref id → account, in the shape `bindCrewFlow` takes as `external`. */
  external: Record<string, string>;
  bindings: CrewExternalBinding[];
  /** Refs nothing bound, sorted. The install must not proceed for their flows. */
  missing: string[];
  /**
   * Refs whose candidates were more than one, so nothing was bound. Also in
   * `missing` — the caller does the same thing either way — but the sentence a
   * human needs is different: pick a crew, rather than install one.
   */
  ambiguous: string[];
};

/**
 * Every seat of a blueprint that a reference could legitimately point at.
 *
 * Exported because a picker needs the same list the resolution walks: an
 * operator choosing "which desk" must be choosing between the candidates that
 * would actually bind, not a wider list that then refuses.
 */
export function externalSeatCandidates(
  seat: CrewExternalSeat,
  candidates: readonly CrewExternalCandidate[],
): CrewExternalCandidate[] {
  return candidates.filter((c) => {
    if (c.roleId?.trim() !== seat.roleId) return false;
    if (!c.account?.trim()) return false;
    // When the blueprint names the sibling it expects, a candidate that cannot
    // prove it came from that blueprint is not a match. Failing closed here is
    // the difference between "the desk's executor" and "an executor".
    if (seat.crewBlueprintId && c.blueprintId?.trim() !== seat.crewBlueprintId) return false;
    return true;
  });
}

/**
 * Resolve every external reference a blueprint declares.
 *
 * `choices` narrows a reference to one crew — the operator's answer to "which
 * desk does this watchdog halt". It selects among candidates; it never supplies
 * an address, so an operator cannot bind a reference to an account nobody hired.
 * A choice naming a crew with no matching seat resolves to nothing rather than
 * falling back to the wider list: a stale pick must not silently retarget the
 * halt at a different crew.
 */
export function resolveExternalSeats(
  bp: CrewBlueprint,
  candidates: readonly CrewExternalCandidate[],
  choices: Record<string, string> = {},
): CrewExternalResolution {
  const external: Record<string, string> = {};
  const bindings: CrewExternalBinding[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];

  for (const seat of bp.externalSeats ?? []) {
    const all = externalSeatCandidates(seat, candidates);
    const chosen = choices[seat.id]?.trim();
    const pool = chosen ? all.filter((c) => c.crewId?.trim() === chosen) : all;
    if (pool.length > 1) {
      ambiguous.push(seat.id);
      missing.push(seat.id);
      continue;
    }
    const hit = pool[0];
    if (!hit) {
      missing.push(seat.id);
      continue;
    }
    const account = hit.account.trim();
    external[seat.id] = account;
    bindings.push({
      ref: seat.id,
      account,
      ...(hit.crewId?.trim() ? { crewId: hit.crewId.trim() } : {}),
      ...(hit.blueprintId?.trim() ? { blueprintId: hit.blueprintId.trim() } : {}),
    });
  }

  return { external, bindings, missing: missing.sort(), ambiguous: ambiguous.sort() };
}

/**
 * Why a reference did not bind, in one sentence an operator can act on.
 *
 * Written here rather than at each surface so a self-host's CLI and the hosted
 * install dialog cannot describe the same refusal two different ways.
 */
export function externalSeatRefusal(
  seat: CrewExternalSeat,
  resolution: CrewExternalResolution,
): string | null {
  if (!resolution.missing.includes(seat.id)) return null;
  const crew = seat.crewBlueprintId ? `a ${seat.crewBlueprintId} crew` : "a sibling crew";
  if (resolution.ambiguous.includes(seat.id)) {
    return `${seat.label}: more than one ${seat.roleId} seat could be meant — name the crew this refers to, because picking one for you would halt somebody at random.`;
  }
  return `${seat.label}: no ${seat.roleId} seat of ${crew} has landed in this workspace, so there is nothing to bind — install it, or leave this crew without the authority.`;
}

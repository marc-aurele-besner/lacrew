/**
 * Who may settle a pending intent, restated from `EscalationRouter.resolve`.
 *
 * Authority to resolve belongs to nodes that are in the tree and active now,
 * not to whoever held the seat when the intent was created:
 *
 *  - the awaiting approver resolves, and only while it is an active node;
 *  - when that approver has been deactivated or removed, the org root resolves
 *    in its place, and nobody else does;
 *  - approval (not rejection) also needs the proposing agent to still be an
 *    active node.
 *
 * The ledger enforces all three. This is the read a caller makes first, so it
 * signs as the seat the ledger will accept and asks the right person.
 */

import type { Intent, OrgNode } from "./types.js";

export interface ApprovalSeat {
  /** The account whose `resolve` the ledger accepts, or null when nobody is awaited. */
  resolver: `0x${string}` | null;
  /** True when `resolver` is the org root covering an inactive or removed approver. */
  standIn: boolean;
  /** False when the proposing agent is inactive or gone: the intent can only be rejected. */
  agentActive: boolean;
}

/**
 * `tree` is the org as the ledger holds it: inactive nodes present and marked,
 * removed nodes absent. A node missing from it reads as removed.
 */
export function approvalSeat(
  intent: Pick<Intent, "agent" | "awaitingApprover">,
  tree: readonly OrgNode[],
): ApprovalSeat {
  const isActive = (account: string): boolean => {
    const wanted = account.toLowerCase();
    return tree.some((n) => n.active && n.account.toLowerCase() === wanted);
  };
  const agentActive = isActive(intent.agent);
  const awaiting = intent.awaitingApprover;
  if (!awaiting) return { resolver: null, standIn: false, agentActive };
  if (isActive(awaiting)) return { resolver: awaiting, standIn: false, agentActive };
  const root = tree.find((n) => n.parent === null) ?? tree.find((n) => n.kind === "human_root");
  return { resolver: root?.account ?? null, standIn: true, agentActive };
}

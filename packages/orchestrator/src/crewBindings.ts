/**
 * Blueprint seat bindings in the live process (PRD F2.25).
 *
 * `@lacrew/flows` owns what a binding *is* — how it is keyed, what makes one
 * valid, and how it is layered over a node list — so a CLI or a control plane
 * can speak the vocabulary without a runtime. This module owns the parts that
 * need one: the stored rows, the hydration at boot, and the invariant that an
 * account holds one seat.
 *
 * ## Why an orchestrator holds this at all
 *
 * The chain stores `{account, kind, parent, active}` and no names. A blueprint's
 * flows name seats by role id, so *something* has to remember that `pr-triager`
 * landed on `0x…`. The hosted control plane remembers it per tenant; a self-host
 * remembered it nowhere, and carried the mapping on the command line
 * (`crews checklist --bind pr-triager=0x…`) out of whatever plan file the
 * operator installed from. Lose the file and every renamed seat goes with it.
 *
 * ## What it is not
 *
 * Not authority, and not a second opinion about whether a crew works. A stored
 * role id *finds* a seat; readiness is still derived live, every time. Nothing
 * here admits a target, budgets an agent or grants a key.
 *
 * ## Failing open, deliberately
 *
 * An unreadable store leaves seats resolving the way they did before anyone
 * stored an id: by label, with the misses named rather than guessed at. That is
 * the right direction because this record *finds* things — it bounds nothing —
 * and refusing to serve an org chart because a bookkeeping table was briefly
 * unreachable would turn a lookup aid into an outage. The failure is logged and
 * the boot says how many rows loaded, so a silent zero is not read as "nobody
 * ever bound a seat".
 */

import {
  applyCrewRoleIds,
  crewBindingKey,
  crewBindingRoles,
  crewBindingScope,
  normalizeCrewBinding,
  type CrewRoleBinding,
  type CrewRoleBindingInput,
} from "@lacrew/flows";
import type { ProtocolEvent } from "@lacrew/core";

export interface CrewBindingStore {
  loadCrewBindings(): Promise<CrewRoleBinding[]>;
  saveCrewBinding(record: CrewRoleBinding): Promise<void>;
  removeCrewBinding(key: string): Promise<void>;
}

export type CrewBindingsSurface = {
  /** Every binding, newest write last. */
  list(scope?: { crewId?: string | null; blueprintId?: string | null }): CrewRoleBinding[];
  /** Role id → account for one scope, in the shape `bindCrewFlow` takes. */
  roles(scope?: { crewId?: string | null; blueprintId?: string | null }): Record<string, string>;
  /** Record one seat. Rebinding a role, or an account, replaces what it displaced. */
  set(input: CrewRoleBindingInput): Promise<CrewRoleBinding>;
  /** Forget one seat. Returns whether there was one. */
  clear(scope: {
    roleId: string;
    crewId?: string | null;
    blueprintId?: string | null;
  }): Promise<boolean>;
  /** Layer `roleId` onto served nodes; a node that carries one already keeps it. */
  apply<T extends { account?: string | null; roleId?: string | null }>(nodes: readonly T[]): T[];
  hydrate(): Promise<number>;
};

export function createCrewBindings(
  opts: {
    store?: CrewBindingStore;
    onEvent?: (event: ProtocolEvent) => void;
    now?: () => Date;
  } = {},
): CrewBindingsSurface {
  const now = opts.now ?? (() => new Date());
  const bindings = new Map<string, CrewRoleBinding>();

  const matching = (scope?: {
    crewId?: string | null;
    blueprintId?: string | null;
  }): CrewRoleBinding[] => {
    const wanted = scope ? crewBindingScope(scope) : null;
    return [...bindings.values()].filter((b) => !wanted || crewBindingScope(b) === wanted);
  };

  return {
    list: (scope) => matching(scope),

    roles: (scope) => crewBindingRoles([...bindings.values()], scope),

    set: async (input) => {
      const record = normalizeCrewBinding(input, now().toISOString());
      const key = crewBindingKey(record);
      /*
        An account holds one seat. Without this, rebinding a role to a new
        account leaves the old pair in the map, and `apply` — which reads
        account → role id — would keep answering with a seat nobody holds any
        more. Scoped to the same crew: the same address genuinely sitting on two
        crews is a workspace's own business, and it is `resolveCrewSeats` that
        refuses to bind one account to two roles of one blueprint.
      */
      const scope = crewBindingScope(record);
      for (const [otherKey, other] of bindings) {
        if (otherKey === key) continue;
        if (crewBindingScope(other) !== scope) continue;
        if (other.account !== record.account) continue;
        bindings.delete(otherKey);
        await opts.store?.removeCrewBinding(otherKey);
      }
      bindings.set(key, record);
      await opts.store?.saveCrewBinding(record);
      opts.onEvent?.({
        type: "CrewBindingChanged",
        at: record.at,
        payload: {
          scope,
          roleId: record.roleId,
          account: record.account,
          action: "set",
          ...(record.blueprintId ? { blueprintId: record.blueprintId } : {}),
          ...(record.crewId ? { crewId: record.crewId } : {}),
        },
      });
      return record;
    },

    clear: async (scope) => {
      const roleId = scope.roleId?.trim();
      if (!roleId) return false;
      const key = crewBindingKey({ ...scope, roleId });
      const existing = bindings.get(key);
      if (!existing) return false;
      bindings.delete(key);
      await opts.store?.removeCrewBinding(key);
      opts.onEvent?.({
        type: "CrewBindingChanged",
        at: now().toISOString(),
        payload: {
          scope: crewBindingScope(existing),
          roleId: existing.roleId,
          account: existing.account,
          action: "cleared",
        },
      });
      return true;
    },

    apply: (nodes) => applyCrewRoleIds(nodes, [...bindings.values()]),

    // Errors propagate: the caller decides what an unreadable set means, and
    // for this record the answer is to log it and keep serving — see the note
    // at the top of this file on why it fails open.
    hydrate: async () => {
      if (!opts.store) return 0;
      const loaded = await opts.store.loadCrewBindings();
      for (const record of loaded) bindings.set(crewBindingKey(record), record);
      return loaded.length;
    },
  };
}

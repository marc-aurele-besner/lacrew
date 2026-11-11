/**
 * Everything about an org that a `ProtocolClient` can read, as one comparable
 * value. Two drivers that agree on this agree on what any consumer of the
 * client would see.
 *
 * A section that cannot be read is recorded as such rather than failing the
 * snapshot: an unreadable tree is itself a state both drivers must share.
 */

import type { Driver } from "./driver.js";
import { normalise, type Address, type Names } from "./refs.js";

const UNREADABLE = "unreadable";

async function section<T>(read: () => Promise<T>): Promise<T | typeof UNREADABLE> {
  try {
    return await read();
  } catch {
    return UNREADABLE;
  }
}

/** `watch` names the accounts whose spend-token balance is recorded. */
export async function snapshot(
  driver: Driver,
  names: Names,
  watch: Record<string, Address>,
): Promise<unknown> {
  const client = driver.client;

  const sessions = await section(async () => {
    const keys = await client.getSessions();
    const out = [];
    for (const key of keys) {
      // `revoked` folds in an expiry judged by the reader's clock; what the
      // ledger itself honours right now is `keyLimits`.
      const { revoked: _revoked, ...rest } = key;
      const limits = key.keyAddress ? await client.readKeyLimits(key.agent, key.keyAddress) : null;
      out.push({ ...rest, limits });
    }
    return out;
  });

  const balances: Record<string, bigint> = {};
  for (const [name, account] of Object.entries(watch)) {
    balances[name] = await driver.balanceOf(account);
  }

  const state = {
    now: driver.now(),
    tree: await section(() => client.getOrgTree()),
    allowances: await section(() => client.getAllowances()),
    treasury: await section(() => client.getTreasuryBalances()),
    pending: await section(() => client.getPendingIntents()),
    sessions,
    issuer: await section(() => client.getIssuer()),
    epoch: await section(() => client.getCurrentEpoch()),
    grants: await section(() => client.getGrants()),
    proposals: await section(() => client.getProposals()),
    governance: await section(() => client.readGovernanceConfig()),
    seats: await section(() => client.readGovernanceSeats({ includeRevoked: true })),
    policies: await section(() => client.getNodePolicies()),
    balances,
  };
  return normalise(state, names.labels());
}

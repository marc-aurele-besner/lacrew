/**
 * A passkey-owned Safe as the onchain approver (PRD F2.6 / F1.3).
 *
 * `rootAuth.ts` answers "did the root consent to this". This answers the half
 * the chain cares about: **who sends the transaction**. `EscalationRouter.resolve`
 * reverts for any sender that is not the intent's `awaitingApprover`, so a Safe
 * root only really holds its authority if the Safe is the sender — not an EOA
 * this orchestrator happens to hold a key for, however carefully that key is
 * guarded. Proving identity in a browser while a different address moves the
 * money is the substitution the non-custodial claim rules out.
 *
 * The two halves are one ceremony. The challenge minted for an approval is the
 * Safe transaction's own hash, so the assertion the root collects is both the
 * proof verified here and the ERC-1271 signature the Safe's WebAuthn signer
 * verifies inside `execTransaction`.
 *
 * Who broadcasts is a deployment decision, and the two modes are separate
 * answers rather than a flag, exactly as for root-Safe deployment:
 *
 * - No relayer configured: the built `execTransaction` is handed back and the
 *   caller's own wallet sends it. Nothing is recorded until the chain is
 *   re-read, because a transaction that was returned is not one that landed.
 * - A relayer configured *for this chain id*: this broadcasts and waits. There
 *   is no default allowlist, so a key set up for anvil cannot become a mainnet
 *   sender because a chain id changed.
 */

import { createPublicClient, http } from "viem";
import {
  assertSafeIsAwaitingApprover,
  buildSafeResolveExecution,
  buildSafeResolvePlan,
  hashToChallenge,
  predictPasskeyOwner,
  relaySafeExecution,
  verifySafeApprover,
  type SafeExecution,
  type SafeResolvePlan,
} from "@lacrew/adapter-wallet-safe";
import type { RootPasskeyProof } from "@lacrew/core";

export type SafeApprovalOptions = {
  /** RPC the plan is read through and the relayer (if any) broadcasts on. */
  provider: string;
  /** The org's root Safe — the address the chain must see as `msg.sender`. */
  safeAddress: `0x${string}`;
  escalationRouter: `0x${string}`;
  /** COSE public key of the root credential; the Safe's owner is derived from it. */
  publicKey: string;
  /** Sender key for the relayed mode. Absent means the caller broadcasts. */
  relayerKey?: `0x${string}`;
  /** Chain ids the relayer may spend on. Empty relays nowhere. */
  allowChainIds?: readonly number[];
};

/** Everything a caller needs to sign, or to send, one Safe-root approval. */
export type SafeApprovalChallenge = {
  /** base64url of the Safe transaction hash — the WebAuthn challenge. */
  challenge: string;
  safeTxHash: `0x${string}`;
  safeAddress: `0x${string}`;
};

export type SafeApprovalResult =
  /** Relayed here: the resolve is on chain. */
  | { sent: true; txHash: `0x${string}`; safeTxHash: `0x${string}` }
  /** Built only: the caller's wallet is the sender, and nothing has happened yet. */
  | { sent: false; execution: SafeExecution; safeTxHash: `0x${string}` };

export interface SafeApprovalSurface {
  readonly safeAddress: `0x${string}`;
  /** True when this orchestrator can broadcast the Safe transaction itself. */
  canRelay(): Promise<boolean>;
  /**
   * The Safe transaction hash one decision on one intent would produce, as a
   * WebAuthn challenge. Reads the Safe's live nonce, so a challenge stops being
   * answerable the moment any other Safe transaction lands — which is the
   * replay protection, and it comes from the Safe rather than from us.
   */
  challengeFor(intentId: string, approved: boolean): Promise<SafeApprovalChallenge>;
  /**
   * Turn a verified root assertion into the Safe's own transaction, and send it
   * where this deployment is allowed to. Refuses — never falls back to a held
   * key — when anything about the Safe fails to check out.
   */
  submit(input: {
    intentId: string;
    approved: boolean;
    awaitingApprover: `0x${string}` | null;
    proof: RootPasskeyProof;
  }): Promise<SafeApprovalResult>;
}

/** Raised for the refusals a caller can act on; the route maps these to 4xx. */
export class SafeApprovalRefusal extends Error {}

export function createSafeApprovalSurface(opts: SafeApprovalOptions): SafeApprovalSurface {
  const allowChainIds = opts.allowChainIds ?? [];
  const client = createPublicClient({ transport: http(opts.provider) });

  async function relayableHere(): Promise<boolean> {
    if (!opts.relayerKey || allowChainIds.length === 0) return false;
    return allowChainIds.includes(await client.getChainId());
  }

  async function plan(intentId: string, approved: boolean): Promise<SafeResolvePlan> {
    return buildSafeResolvePlan(client, {
      safeAddress: opts.safeAddress,
      escalationRouter: opts.escalationRouter,
      intentId,
      approved,
    });
  }

  /**
   * The signer address the root credential implies, asked of the canonical
   * factory. Deploying a Safe confers no ownership, so "a Safe exists at the
   * root address" is not the question — "is it 1-of-1 owned by *this*
   * credential" is.
   */
  async function assertSafeIsTheRoots(): Promise<void> {
    const owner = await predictPasskeyOwner(client, opts.publicKey);
    const verification = await verifySafeApprover({
      provider: opts.provider,
      safeAddress: opts.safeAddress,
      expectedOwner: owner.address,
    });
    if (!verification.ownerMatches) {
      throw new SafeApprovalRefusal(
        `root_safe_not_passkey_owned: ${verification.reason ?? "the root Safe is not 1-of-1 owned by the root credential."}`,
      );
    }
  }

  return {
    safeAddress: opts.safeAddress,
    canRelay: relayableHere,

    async challengeFor(intentId, approved) {
      const built = await plan(intentId, approved);
      return {
        challenge: hashToChallenge(built.safeTxHash),
        safeTxHash: built.safeTxHash,
        safeAddress: opts.safeAddress,
      };
    },

    async submit({ intentId, approved, awaitingApprover, proof }) {
      // The chain has to be waiting on the Safe. If it is waiting on anything
      // else, this refuses by name rather than looking around for a key that
      // could sign instead — an approval settled by whatever address the
      // orchestrator holds is the failure this path exists to prevent.
      try {
        assertSafeIsAwaitingApprover(opts.safeAddress, awaitingApprover);
      } catch (err) {
        throw new SafeApprovalRefusal(err instanceof Error ? err.message : String(err));
      }
      await assertSafeIsTheRoots();

      // Rebuilt rather than remembered. The hash folds in the Safe's live
      // nonce, so rebuilding is also the check that nothing moved underneath
      // the ceremony: if it did, the assertion no longer answers this hash and
      // the build below refuses.
      const built = await plan(intentId, approved);
      const owner = await predictPasskeyOwner(client, opts.publicKey);
      let execution: SafeExecution;
      try {
        execution = buildSafeResolveExecution(built, owner.address, proof);
      } catch (err) {
        throw new SafeApprovalRefusal(err instanceof Error ? err.message : String(err));
      }

      if (!(await relayableHere())) {
        return { sent: false, execution, safeTxHash: built.safeTxHash };
      }
      const relayed = await relaySafeExecution({
        provider: opts.provider,
        privateKey: opts.relayerKey!,
        allowChainIds,
        execution,
      });
      return { sent: true, txHash: relayed.hash, safeTxHash: built.safeTxHash };
    },
  };
}

/**
 * Chains the approval relayer may broadcast on. Empty unless an operator listed
 * them — same discipline as `LACREW_ROOT_DEPLOY_RELAY_CHAINS`, and for the same
 * reason: the chain a deployment ends up pointed at is exactly the thing that
 * changes without anyone revisiting a relayer setting.
 */
export function safeApprovalRelayChains(env: NodeJS.ProcessEnv = process.env): number[] {
  return (env.LACREW_ROOT_APPROVAL_RELAY_CHAINS ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export function safeApprovalRelayer(env: NodeJS.ProcessEnv = process.env): `0x${string}` | null {
  const key = env.LACREW_ROOT_APPROVAL_RELAYER?.trim();
  return key ? (key as `0x${string}`) : null;
}

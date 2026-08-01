/**
 * Root authorization for session revoke and rotate (PRD F0.7 / F1.3).
 *
 * The orchestrator issues the challenge and verifies the proof itself. That
 * placement is the whole point: a control plane in front of it can decide *who
 * may ask*, but it cannot mint the root's consent, so "revocation runs from the
 * user's root key, never the cloud's" is a property of the code rather than a
 * promise about the deployment.
 *
 * Challenges are single-use, expiring, and bound to (action, subject). An
 * assertion collected to revoke key 7 is therefore not an assertion to revoke
 * key 8, nor to rotate key 7 into a fresh one — rotate re-issues authority and
 * revoke only removes it, and consent to one is not consent to the other.
 */

import { randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { verifyWebAuthnAssertion } from "@lacrew/adapter-wallet-safe";
import {
  rootAuthConfigError,
  rootChallengeStatement,
  type RootAuthAction,
  type RootAuthConfig,
  type RootChallenge,
  type RootProof,
} from "@lacrew/core";

const DEFAULT_TTL_SEC = 300;
/** Enough for concurrent operators; a bound keeps a challenge flood from growing memory. */
const MAX_PENDING = 256;

/**
 * `via: "unconfigured"` is kept distinct from a verified proof so the audit
 * trail never records a root as having authorized something no root was asked
 * about.
 */
export type RootAuthOutcome =
  | { ok: true; via: "passkey" | "wallet" | "unconfigured" }
  | { ok: false; error: string; status: 400 | 401 | 501 };

export interface RootAuthStatus {
  /** True when this orchestrator will demand a proof for revoke/rotate. */
  required: boolean;
  kind: RootAuthConfig["kind"] | null;
  /** Present when a config was supplied but cannot verify anything. */
  configError: string | null;
  pendingChallenges: number;
  challengeTtlSec: number;
}

export interface RootAuthSurface {
  readonly required: boolean;
  readonly kind: RootAuthConfig["kind"] | null;
  /** Mint a challenge for one action on one subject. */
  issueChallenge(action: RootAuthAction, subject: string): RootChallenge;
  /**
   * Consume the challenge and check the proof. Never throws: a caller that
   * cannot revoke needs the reason, and an exception here would read as an
   * orchestrator fault rather than a refused authorization.
   */
  verify(input: {
    action: RootAuthAction;
    subject: string;
    challenge?: string;
    proof?: RootProof;
  }): Promise<RootAuthOutcome>;
  status(): RootAuthStatus;
}

export interface RootAuthOptions {
  /** Absent = no root authorization configured; revoke/rotate stay ungated. */
  config?: RootAuthConfig | null;
  /**
   * The chain's `SessionRegistry.humanRoot`, when one is readable. A configured
   * wallet address that disagrees with it is refused rather than trusted: the
   * chain is what actually gates `revoke`, so a proof from any other address
   * would authorize a transaction that then reverts.
   */
  humanRoot?: () => Promise<`0x${string}` | null>;
  /** The chain the wallet statement is scoped to, when known. */
  chainId?: () => number | null;
  challengeTtlSec?: number;
  now?: () => number;
}

type Pending = {
  action: RootAuthAction;
  subject: string;
  expiresAt: number;
};

/** `LACREW_ROOT_AUTH=passkey|wallet` plus that kind's material. */
export function readRootAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): RootAuthConfig | null {
  const kind = env.LACREW_ROOT_AUTH?.trim().toLowerCase();
  if (!kind) return null;
  if (kind === "passkey") {
    return {
      kind: "passkey",
      credentialId: env.LACREW_ROOT_PASSKEY_ID?.trim(),
      publicKey: env.LACREW_ROOT_PASSKEY_PUBKEY?.trim(),
      rpId: env.LACREW_ROOT_PASSKEY_RPID?.trim(),
      origin: env.LACREW_ROOT_PASSKEY_ORIGIN?.trim(),
    };
  }
  if (kind === "wallet") {
    const address = env.LACREW_ROOT_ADDRESS?.trim();
    return {
      kind: "wallet",
      address: address ? (address as `0x${string}`) : undefined,
    };
  }
  throw new Error(
    `LACREW_ROOT_AUTH=${kind} is not a root account kind — use "passkey" or "wallet".`,
  );
}

export function createRootAuthSurface(
  options: RootAuthOptions = {},
): RootAuthSurface {
  const config = options.config ?? null;
  const now = options.now ?? (() => Date.now());
  const ttlSec = options.challengeTtlSec ?? DEFAULT_TTL_SEC;
  const configError = config ? rootAuthConfigError(config) : null;
  const pending = new Map<string, Pending>();

  function prune(): void {
    const at = now();
    for (const [challenge, record] of pending) {
      if (record.expiresAt <= at) pending.delete(challenge);
    }
  }

  function issueChallenge(
    action: RootAuthAction,
    subject: string,
  ): RootChallenge {
    prune();
    if (pending.size >= MAX_PENDING) {
      // Oldest first: a burst of unanswered challenges must not lock out the
      // operator who is actually standing at the authenticator.
      const oldest = [...pending.entries()].sort(
        (a, b) => a[1].expiresAt - b[1].expiresAt,
      )[0];
      if (oldest) pending.delete(oldest[0]);
    }
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = now() + ttlSec * 1000;
    pending.set(challenge, { action, subject, expiresAt });
    const chainId = options.chainId?.() ?? undefined;
    return {
      challenge,
      action,
      subject,
      expiresAt,
      statement: rootChallengeStatement({
        action,
        subject,
        challenge,
        ...(chainId !== null && chainId !== undefined ? { chainId } : {}),
      }),
    };
  }

  async function verify(input: {
    action: RootAuthAction;
    subject: string;
    challenge?: string;
    proof?: RootProof;
  }): Promise<RootAuthOutcome> {
    if (!config) return { ok: true, via: "unconfigured" };
    if (configError) {
      // Configured-but-unusable is a 501, not a 401: nothing the caller sends
      // could pass, and reporting it as a bad proof would send an operator
      // hunting for a signature problem that is really a deployment problem.
      return {
        ok: false,
        error: `root_auth_misconfigured: ${configError}`,
        status: 501,
      };
    }
    if (!input.proof)
      return { ok: false, error: "root_proof_required", status: 401 };
    if (!input.challenge)
      return { ok: false, error: "challenge_required", status: 400 };

    prune();
    const record = pending.get(input.challenge);
    // Burned on any attempt, pass or fail: a challenge that survived a failure
    // would let a caller grind proofs against one live nonce.
    pending.delete(input.challenge);
    if (!record)
      return { ok: false, error: "challenge_expired_or_unknown", status: 401 };
    if (record.action !== input.action || record.subject !== input.subject) {
      return { ok: false, error: "challenge_not_for_this_action", status: 401 };
    }

    if (config.kind === "passkey") {
      if (input.proof.kind !== "passkey") {
        return { ok: false, error: "root_is_a_passkey", status: 400 };
      }
      if (input.proof.credentialId !== config.credentialId) {
        return { ok: false, error: "unknown_credential", status: 401 };
      }
      const verified = verifyWebAuthnAssertion({
        publicKey: config.publicKey!,
        challenge: input.challenge,
        rpId: config.rpId!,
        origin: config.origin!,
        authenticatorData: input.proof.authenticatorData,
        clientDataJSON: input.proof.clientDataJSON,
        signature: input.proof.signature,
      });
      if (!verified.verified)
        return { ok: false, error: verified.error, status: 401 };
      return { ok: true, via: "passkey" };
    }

    if (input.proof.kind !== "wallet") {
      return { ok: false, error: "root_is_a_wallet", status: 400 };
    }
    const expected = config.address!.toLowerCase();
    const onchainRoot = await options.humanRoot?.().catch(() => null);
    if (onchainRoot && onchainRoot.toLowerCase() !== expected) {
      return {
        ok: false,
        error: `root_address_not_onchain_root: configured ${config.address}, chain says ${onchainRoot}`,
        status: 501,
      };
    }
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message: statementFor(record, input.challenge, options),
        signature: input.proof.signature,
      });
    } catch {
      return { ok: false, error: "signature_unrecoverable", status: 401 };
    }
    if (recovered.toLowerCase() !== expected) {
      return { ok: false, error: "signature_not_from_root", status: 401 };
    }
    if (input.proof.address.toLowerCase() !== expected) {
      return { ok: false, error: "address_not_root", status: 401 };
    }
    return { ok: true, via: "wallet" };
  }

  return {
    get required() {
      return config !== null;
    },
    get kind() {
      return config?.kind ?? null;
    },
    issueChallenge,
    verify,
    status() {
      prune();
      return {
        required: config !== null,
        kind: config?.kind ?? null,
        configError,
        pendingChallenges: pending.size,
        challengeTtlSec: ttlSec,
      };
    },
  };
}

function statementFor(
  record: Pending,
  challenge: string,
  options: RootAuthOptions,
): string {
  const chainId = options.chainId?.() ?? undefined;
  return rootChallengeStatement({
    action: record.action,
    subject: record.subject,
    challenge,
    ...(chainId !== null && chainId !== undefined ? { chainId } : {}),
  });
}

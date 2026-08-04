/**
 * Root authorization for the actions only the workspace root may take
 * (PRD F0.7 / F1.3 / F2.6).
 *
 * Session keys are the blast-radius boundary, so the two actions that move that
 * boundary — retiring a key and re-issuing one — are proved by the workspace
 * root, not by whoever happens to hold an orchestrator or cloud credential. The
 * proof is verified where the action executes (the orchestrator), so a cloud
 * control plane can gate the request but can never manufacture the authority.
 *
 * Approving an escalated intent that has climbed to the human root is the same
 * kind of decision about the same money, so it proves the same way.
 *
 * The vocabulary lives here because four layers speak it: the orchestrator
 * issues and verifies, the SDK and CLI carry it, and the cloud relays it.
 */

/** Which kind of account the workspace root is, and therefore how it proves. */
export type RootAuthKind = "passkey" | "wallet";

/**
 * What a proof authorizes. Bound into the challenge record, so a proof
 * collected for one action can never be replayed as another — a rotate
 * re-issues authority, a revoke only removes it, and they are not the same
 * consent. Approving a spend and refusing one are likewise opposites, and an
 * assertion collected for the second must never settle the first.
 */
export type RootAuthAction = "session:revoke" | "session:rotate" | "intent:approve" | "intent:deny";

/**
 * Every action a root proof can authorize. Exported so the layers that only
 * carry proofs validate against one list rather than each keeping its own copy
 * — a relay that silently drops an action it has not heard of is a gate that
 * stops applying the moment a new one ships.
 */
export const ROOT_AUTH_ACTIONS: readonly RootAuthAction[] = [
  "session:revoke",
  "session:rotate",
  "intent:approve",
  "intent:deny",
];

/**
 * A single-use challenge the root signs. `subject` is what the proof is bound
 * to — the session id for a lifecycle action, the intent id for an approval.
 * Without it, one revoke's assertion would authorize revoking any other key,
 * and one approval's would release any other pending spend.
 */
export interface RootChallenge {
  /** Opaque nonce (base64url). The WebAuthn challenge; part of the wallet statement. */
  challenge: string;
  action: RootAuthAction;
  subject: string;
  /** Unix ms after which the challenge is refused. */
  expiresAt: number;
  /** Exactly the string a wallet root must `personal_sign`. */
  statement: string;
}

/** A WebAuthn assertion from the root's passkey. */
export interface RootPasskeyProof {
  kind: "passkey";
  /** base64url credential id, matched against the registered credential. */
  credentialId: string;
  /** base64url `authenticatorData`. */
  authenticatorData: string;
  /** base64url `clientDataJSON`. */
  clientDataJSON: string;
  /** base64url DER ECDSA signature. */
  signature: string;
}

/** An EIP-191 `personal_sign` over the challenge statement. */
export interface RootWalletProof {
  kind: "wallet";
  address: `0x${string}`;
  signature: `0x${string}`;
}

export type RootProof = RootPasskeyProof | RootWalletProof;

/**
 * How this orchestrator recognises its root. Absent = no root authorization is
 * configured, which is reported as such rather than silently treated as
 * "anything goes": a deployment that believes it has root-anchored revoke and
 * does not is the failure this whole surface exists to prevent.
 */
export interface RootAuthConfig {
  kind: RootAuthKind;
  /** Passkey: base64url credential id of the registered root credential. */
  credentialId?: string;
  /** Passkey: base64url COSE public key from the registration attestation. */
  publicKey?: string;
  /** Passkey: relying-party id the assertion must be scoped to. */
  rpId?: string;
  /** Passkey: origin the assertion must have been collected at. */
  origin?: string;
  /**
   * Wallet: the address that must have signed. Checked against the chain's
   * `SessionRegistry.humanRoot` where one is readable, so a misconfigured
   * address cannot quietly stand in for the real root.
   */
  address?: `0x${string}`;
}

/** The exact message a wallet root signs. One line per field, no free text. */
export function rootChallengeStatement(input: {
  action: RootAuthAction;
  subject: string;
  challenge: string;
  chainId?: number;
}): string {
  return [
    "LaCrew root authorization",
    `action: ${input.action}`,
    `subject: ${input.subject}`,
    `challenge: ${input.challenge}`,
    ...(input.chainId !== undefined ? [`chainId: ${input.chainId}`] : []),
  ].join("\n");
}

/** Whether a config can actually verify a proof, and what is missing if not. */
export function rootAuthConfigError(config: RootAuthConfig): string | null {
  if (config.kind === "passkey") {
    if (!config.credentialId) return "passkey root auth needs a credentialId";
    if (!config.publicKey) return "passkey root auth needs a COSE publicKey";
    if (!config.rpId) return "passkey root auth needs an rpId";
    if (!config.origin) return "passkey root auth needs an origin";
    return null;
  }
  if (!config.address) return "wallet root auth needs an address";
  return null;
}

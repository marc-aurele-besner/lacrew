/**
 * Settle a pending intent through an orchestrator, root proof and all
 * (PRD F2.6 / F1.3).
 *
 * The orchestrator refuses to resolve a root-depth intent without a fresh proof
 * from the workspace root, which leaves every caller with the same three steps:
 * ask whether this intent needs the root, collect the root's consent if it
 * does, and send both. Written once here so a consumer cannot accidentally
 * implement the first two as "send it and see" — a caller that treats the
 * refusal as a transport error and retries without a proof is a caller that
 * looks broken rather than gated.
 *
 * Nothing here holds root key material. A wallet root's key is the caller's to
 * pass, signs in the caller's process, and is used for exactly one statement; a
 * passkey root's private half never leaves the authenticator, so its assertion
 * has to be collected where the authenticator is and handed in as `proof`.
 */

import type { RootChallenge, RootProof } from "@lacrew/core";

/** Just enough of a viem `Account` to sign one statement. */
export interface RootSigner {
  address: `0x${string}`;
  signMessage(args: { message: string }): Promise<`0x${string}`>;
}

export interface ResolveIntentOptions {
  intentId: string;
  approved: boolean;
  /** Orchestrator base URL. Defaults to `ORCH_URL` or the local dev port. */
  url?: string;
  /** Bearer token, when the orchestrator is protected. */
  token?: string;
  /**
   * A proof collected elsewhere — the only path for a passkey root, whose
   * assertion this process cannot produce.
   */
  proof?: RootProof;
  /** A wallet root's signer, when the caller holds it. */
  rootAccount?: RootSigner;
  fetchImpl?: typeof fetch;
}

export interface ResolvedIntent {
  txHash?: `0x${string}`;
  /** Present when a Safe root executed the resolve; the hash it signed. */
  safeTxHash?: `0x${string}`;
  escalated: boolean;
  /**
   * `root:passkey`, `root:safe-passkey`, `root:wallet`, `approver`, or
   * `unauthenticated`.
   */
  authorizedBy: string;
  /** The seat that signed, as the orchestrator read it off the chain. */
  approver: `0x${string}` | null;
  intent: unknown;
}

type ChallengeResponse =
  | ({
      required: true;
      kind: "passkey" | "wallet" | "safe-passkey";
      /** `safe-passkey` only: the Safe, the hash it will execute, and who sends. */
      safeAddress?: `0x${string}`;
      safeTxHash?: `0x${string}`;
      userVerification?: "required";
      relayed?: boolean;
    } & RootChallenge)
  | { required: false; challenge: null; kind: null; awaitingApprover?: string | null };

/**
 * A Safe root's approval, built but not broadcast — this orchestrator relays on
 * no chain, so the transaction is the caller's to send. Raised rather than
 * returned so a caller cannot mistake it for a settled intent: nothing has
 * happened on chain yet, and the intent is still pending.
 */
export class SafeExecutionRequired extends Error {
  constructor(
    readonly transaction: { to: `0x${string}`; data: `0x${string}`; value: string },
    readonly safeTxHash: `0x${string}`,
    detail: string,
  ) {
    super(`safe_exec_unsigned: ${detail}`);
    this.name = "SafeExecutionRequired";
  }
}

const DEFAULT_URL = "http://127.0.0.1:8788";

async function orchPost<T>(
  options: Pick<ResolveIntentOptions, "url" | "token" | "fetchImpl">,
  path: string,
  body: unknown,
): Promise<T> {
  const base = (options.url ?? process.env.ORCH_URL ?? DEFAULT_URL).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    detail?: string;
    safeTxHash?: `0x${string}`;
    transaction?: { to: `0x${string}`; data: `0x${string}`; value: string };
  };
  if (!res.ok) {
    // The one refusal that carries work for the caller rather than a mistake to
    // fix: the Safe's transaction is built and waiting for a sender.
    if (parsed.error === "safe_exec_unsigned" && parsed.transaction && parsed.safeTxHash) {
      throw new SafeExecutionRequired(
        parsed.transaction,
        parsed.safeTxHash,
        parsed.detail ?? "Broadcast it, then confirm.",
      );
    }
    throw new Error(parsed.error ?? `${res.status} ${res.statusText}`);
  }
  return parsed;
}

/**
 * Approve or deny one pending intent.
 *
 * Refuses rather than sending an unproved request when the intent awaits the
 * root and no proof can be produced: the orchestrator would refuse it anyway,
 * and refusing here says which root this workspace has and what it needs to
 * sign, which is what the operator is actually missing.
 */
export async function resolveIntentWithProof(
  options: ResolveIntentOptions,
): Promise<ResolvedIntent> {
  const action = options.approved ? "intent:approve" : "intent:deny";
  const issued = await orchPost<ChallengeResponse>(options, "/root-auth/challenge", {
    action,
    subject: options.intentId,
  });

  let proved: { challenge: string; rootProof: RootProof } | undefined;
  if (issued.required) {
    if (options.proof) {
      proved = { challenge: issued.challenge, rootProof: options.proof };
    } else if (issued.kind === "passkey" || issued.kind === "safe-passkey") {
      throw new Error(
        `root_proof_required: intent ${options.intentId} awaits a ${
          issued.kind === "safe-passkey"
            ? `passkey-owned Safe (${issued.safeAddress}). The challenge is that Safe's own ` +
              `transaction hash, so the assertion must be collected with ` +
              `userVerification: "required" — the Safe's signer will not accept it otherwise`
            : "passkey root"
        }. Collect the assertion where the authenticator is and pass it as \`proof\`. ` +
          `Challenge: ${issued.challenge}`,
      );
    } else if (options.rootAccount) {
      proved = {
        challenge: issued.challenge,
        rootProof: {
          kind: "wallet",
          address: options.rootAccount.address,
          signature: await options.rootAccount.signMessage({ message: issued.statement }),
        },
      };
    } else {
      throw new Error(
        `root_proof_required: intent ${options.intentId} awaits a wallet root. ` +
          `Pass \`rootAccount\` to sign locally, or \`proof\` if it was signed elsewhere. ` +
          `Statement:\n${issued.statement}`,
      );
    }
  }

  return orchPost<ResolvedIntent>(options, "/intents/resolve", {
    intentId: options.intentId,
    approved: options.approved,
    ...(proved ?? {}),
  });
}

/** Approve a pending intent. See {@link resolveIntentWithProof}. */
export function approveIntent(
  options: Omit<ResolveIntentOptions, "approved">,
): Promise<ResolvedIntent> {
  return resolveIntentWithProof({ ...options, approved: true });
}

/** Deny a pending intent. Proved exactly as an approval is — see {@link resolveIntentWithProof}. */
export function denyIntent(
  options: Omit<ResolveIntentOptions, "approved">,
): Promise<ResolvedIntent> {
  return resolveIntentWithProof({ ...options, approved: false });
}

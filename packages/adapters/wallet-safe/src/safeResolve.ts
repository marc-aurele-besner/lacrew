/**
 * A passkey-owned Safe settling its own escalated intents (PRD F2.6 / F1.3).
 *
 * `EscalationRouter.resolve` reverts for any sender that is not the intent's
 * `awaitingApprover`. Where the root is a Safe, that sender has to *be* the
 * Safe — so approving is a Safe transaction the passkey authorizes and anyone
 * may pay for, not an EOA transaction that happens to be sent by someone the
 * product trusts. Without this, a Safe root could prove who it was in a browser
 * while a different address moved the money, which is the exact substitution
 * the non-custodial claim is about.
 *
 * The shape that makes it work is that **one WebAuthn assertion serves two
 * verifiers**. The Safe transaction hash is the challenge, so the assertion
 * the root collects to approve intent 7 is simultaneously:
 *
 * - the proof an orchestrator checks off-chain (same COSE key, same code path
 *   as every other root proof), and
 * - the ERC-1271 signature the Safe's `SafeWebAuthnSigner` owner verifies
 *   onchain inside `execTransaction`.
 *
 * A second, separate ceremony would be worse than redundant: two consents that
 * can disagree is one consent that can be swapped.
 *
 * As everywhere else in this package, building and broadcasting are separate
 * calls. `buildSafeResolveExecution` returns a transaction and holds no key;
 * `relaySafeExecution` is the local/dev sender and refuses any chain the caller
 * did not name.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { p256 } from "@noble/curves/nist.js";
import {
  assertRelayAllowlist,
  assertRelayableChain,
  verifyRootSafeDeployed,
  type RootSafeVerification,
} from "./rootDeploy.js";

/** The router call a root approves or refuses. */
export const escalationResolveAbi = parseAbi(["function resolve(uint256 intentId, bool approved)"]);

const SAFE_TX_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** `resolve(intentId, approved)` calldata — the payload the Safe executes. */
export function encodeEscalationResolve(
  intentId: bigint | string | number,
  approved: boolean,
): `0x${string}` {
  return encodeFunctionData({
    abi: escalationResolveAbi,
    functionName: "resolve",
    args: [BigInt(intentId), approved],
  });
}

/**
 * A Safe transaction, fully specified. Every gas field is zero on purpose:
 * with `safeTxGas` and `gasPrice` both zero the Safe forwards all remaining gas
 * and **reverts when the inner call reverts**, so a resolve the router refused
 * can never come back as a successful `execTransaction` receipt. A refund
 * scheme would also pay the relayer out of the root's own funds, which is not
 * a thing an approval should quietly do.
 */
export type SafeResolveTransaction = {
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  /** 0 = CALL. A root approving a spend never delegatecalls. */
  operation: 0;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: `0x${string}`;
  refundReceiver: `0x${string}`;
  nonce: bigint;
};

export type SafeTransactionPlan = {
  safeAddress: `0x${string}`;
  safeTx: SafeResolveTransaction;
  /**
   * The EIP-712 hash the Safe itself computed. Read from the deployed Safe
   * rather than re-derived here, for the same reason the passkey signer address
   * is asked of the canonical factory: a domain separator this package
   * reimplemented could drift from the one the contract actually checks, and
   * the failure would look like a bad passkey.
   */
  safeTxHash: `0x${string}`;
};

export type SafeResolvePlan = SafeTransactionPlan & {
  intentId: string;
  approved: boolean;
};

/** The exact argument tuple `getTransactionHash` takes, in the Safe's order. */
type SafeTxHashArgs = readonly [
  `0x${string}`,
  bigint,
  `0x${string}`,
  number,
  bigint,
  bigint,
  bigint,
  `0x${string}`,
  `0x${string}`,
  bigint,
];

/** The viem client surface a plan is read through. */
interface ChainReader {
  getCode(args: { address: `0x${string}` }): Promise<string | undefined>;
  readContract(args: {
    address: `0x${string}`;
    abi: typeof SAFE_TX_ABI;
    functionName: "nonce" | "getTransactionHash";
    args?: SafeTxHashArgs;
  }): Promise<unknown>;
}

export type SafeResolveOptions = {
  safeAddress: `0x${string}`;
  escalationRouter: `0x${string}`;
  intentId: bigint | string | number;
  approved: boolean;
};

/**
 * The Safe transaction that settles one intent, and the hash the root signs.
 *
 * The Safe must be deployed: an undeployed Safe cannot answer `nonce()`, cannot
 * be `awaitingApprover`, and cannot execute anything — reporting a plan against
 * one would hand a caller a hash nothing will ever accept.
 *
 * The nonce is read live and folded into the hash, which is what makes a stale
 * assertion useless: any other Safe transaction that lands first moves the
 * nonce, the hash changes, and the old signature stops verifying.
 */
export async function buildSafeResolvePlan(
  client: ChainReader,
  opts: SafeResolveOptions,
): Promise<SafeResolvePlan> {
  return {
    ...(await buildSafeTransactionPlan(client, {
      safeAddress: opts.safeAddress,
      to: opts.escalationRouter,
      data: encodeEscalationResolve(opts.intentId, opts.approved),
    })),
    intentId: BigInt(opts.intentId).toString(),
    approved: opts.approved,
  };
}

/**
 * The same, for any call the Safe makes. A root Safe does more than approve —
 * bootstrapping an org registry is its own `execTransaction` — and the signing
 * story is identical, so the plan builder is not resolve-specific.
 */
export async function buildSafeTransactionPlan(
  client: ChainReader,
  opts: { safeAddress: `0x${string}`; to: `0x${string}`; data: `0x${string}` },
): Promise<SafeTransactionPlan> {
  const safeAddress = getAddress(opts.safeAddress);
  const code = await client.getCode({ address: safeAddress });
  if (!code || code === "0x") {
    throw new Error(
      `safe_not_deployed: no code at ${safeAddress} — a counterfactual Safe cannot execute an approval.`,
    );
  }
  const nonce = (await client.readContract({
    address: safeAddress,
    abi: SAFE_TX_ABI,
    functionName: "nonce",
  })) as bigint;

  const safeTx: SafeResolveTransaction = {
    to: getAddress(opts.to),
    value: 0n,
    data: opts.data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  };

  const safeTxHash = (await client.readContract({
    address: safeAddress,
    abi: SAFE_TX_ABI,
    functionName: "getTransactionHash",
    args: [
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      safeTx.nonce,
    ] satisfies SafeTxHashArgs,
  })) as `0x${string}`;

  return { safeAddress, safeTx, safeTxHash };
}

/** base64url of a 32-byte hash — the form a WebAuthn challenge takes. */
export function hashToChallenge(hash: `0x${string}`): string {
  return Buffer.from(hash.slice(2), "hex").toString("base64url");
}

/**
 * The literal prefix Safe's `WebAuthn.encodeClientDataJson` rebuilds onchain.
 * The contract does not receive `clientDataJSON`; it reconstructs it from the
 * challenge plus whatever fields follow, then hashes the result. So a client
 * data blob that does not start exactly like this hashes to something else and
 * the signature will not verify — which is worth catching here, by name, rather
 * than as an opaque `GS026` from the Safe.
 */
const CLIENT_DATA_PREFIX = '{"type":"webauthn.get","challenge":"';

export type ClientDataParts = {
  /** base64url challenge as the authenticator recorded it. */
  challenge: string;
  /** Everything after the challenge member — what the contract is handed. */
  clientDataFields: string;
};

/**
 * Split a WebAuthn `clientDataJSON` into the challenge the authenticator signed
 * and the trailing fields the Safe needs to rebuild the exact same bytes.
 *
 * Deliberately a string operation on the raw blob rather than a JSON parse and
 * re-serialize: the authenticator signed *these bytes*, and a re-serialization
 * that reorders a key or drops a space produces a different hash while looking
 * identical.
 */
export function splitClientData(clientDataJSON: string | Uint8Array): ClientDataParts {
  const json =
    typeof clientDataJSON === "string"
      ? Buffer.from(clientDataJSON, "base64url").toString("utf8")
      : Buffer.from(clientDataJSON).toString("utf8");
  if (!json.startsWith(CLIENT_DATA_PREFIX)) {
    throw new Error(
      "client_data_not_safe_encodable: the assertion's clientDataJSON does not begin with " +
        "Safe's WebAuthn template, so the Safe cannot reconstruct the bytes that were signed.",
    );
  }
  const rest = json.slice(CLIENT_DATA_PREFIX.length);
  const end = rest.indexOf('"');
  if (end < 0) throw new Error("client_data_not_safe_encodable: unterminated challenge member.");
  const challenge = rest.slice(0, end);
  const after = rest.slice(end + 1);
  if (!after.startsWith(",") || !after.endsWith("}")) {
    throw new Error(
      "client_data_not_safe_encodable: no fields follow the challenge, which Safe's template requires.",
    );
  }
  return { challenge, clientDataFields: after.slice(1, -1) };
}

/**
 * P-256 order. A signature's `s` and `n - s` are both valid, so normalising to
 * the low half costs nothing and satisfies a verifier that rejects the high one
 * — authenticators are not required to produce low-s and several do not.
 */
export function normalizedSignature(derSignature: string | Uint8Array): { r: bigint; s: bigint } {
  const bytes =
    typeof derSignature === "string"
      ? new Uint8Array(Buffer.from(derSignature, "base64url"))
      : derSignature;
  let parsed;
  try {
    parsed = p256.Signature.fromBytes(bytes, "der");
  } catch {
    throw new Error("signature_unparseable: the assertion signature is not DER ECDSA.");
  }
  // noble-curves 2.x removed `Signature.normalizeS()` because produced
  // signatures are forced to low-S by default. Parsed signatures can still be
  // high-S (authenticators aren't required to emit low-S), so reflect them
  // across the subgroup order before returning.
  const n = p256.Point.CURVE().n;
  const normalized = parsed.hasHighS() ? new p256.Signature(parsed.r, n - parsed.s) : parsed;
  return { r: normalized.r, s: normalized.s };
}

export type WebAuthnAssertionBytes = {
  /** base64url `authenticatorData`. */
  authenticatorData: string;
  /** base64url `clientDataJSON`. */
  clientDataJSON: string;
  /** base64url DER ECDSA signature. */
  signature: string;
};

const FLAG_USER_VERIFIED = 0x04;

/**
 * The `bytes` a `SafeWebAuthnSigner` verifies: `abi.encode(authenticatorData,
 * clientDataFields, r, s)`.
 *
 * The user-verified flag is required, not preferred, because the signer
 * contract requires it. A ceremony collected with `userVerification:
 * "preferred"` against an authenticator that skipped it produces a signature
 * that passes every off-chain check and then reverts inside `execTransaction`
 * — an approval that looks granted and moved nothing.
 */
export function encodeWebAuthnSignature(assertion: WebAuthnAssertionBytes): `0x${string}` {
  const authenticatorData = new Uint8Array(Buffer.from(assertion.authenticatorData, "base64url"));
  if (authenticatorData.length < 37) {
    throw new Error("authenticator_data_too_short");
  }
  if ((authenticatorData[32]! & FLAG_USER_VERIFIED) === 0) {
    throw new Error(
      "user_not_verified: the Safe's WebAuthn signer requires the user-verified flag — " +
        'collect the assertion with userVerification: "required".',
    );
  }
  const { clientDataFields } = splitClientData(assertion.clientDataJSON);
  const { r, s } = normalizedSignature(assertion.signature);
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [
      `0x${Buffer.from(authenticatorData).toString("hex")}` as `0x${string}`,
      clientDataFields,
      r,
      s,
    ],
  );
}

/**
 * Frame one contract-owner signature the way `Safe.checkNSignatures` reads it:
 * a 65-byte static entry whose `r` is the owner address, whose `s` is the byte
 * offset of the dynamic part, and whose `v` is zero — then the length-prefixed
 * signature itself. With a 1-of-1 Safe the static section is exactly one entry,
 * so the offset is 65.
 */
export function encodeContractSignature(
  owner: `0x${string}`,
  signature: `0x${string}`,
): `0x${string}` {
  const ownerWord = getAddress(owner).slice(2).toLowerCase().padStart(64, "0");
  const offsetWord = 65n.toString(16).padStart(64, "0");
  const body = signature.slice(2);
  const lengthWord = (BigInt(body.length) / 2n).toString(16).padStart(64, "0");
  return `0x${ownerWord}${offsetWord}00${lengthWord}${body}` as `0x${string}`;
}

export type SafeExecution = {
  /** The Safe. Any funded sender may broadcast this; none of them authorize it. */
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

/** `execTransaction(...)` calldata for a planned Safe transaction. */
export function encodeSafeExecTransaction(
  plan: SafeTransactionPlan,
  signatures: `0x${string}`,
): SafeExecution {
  return {
    to: plan.safeAddress,
    value: 0n,
    data: encodeFunctionData({
      abi: SAFE_TX_ABI,
      functionName: "execTransaction",
      args: [
        plan.safeTx.to,
        plan.safeTx.value,
        plan.safeTx.data,
        plan.safeTx.operation,
        plan.safeTx.safeTxGas,
        plan.safeTx.baseGas,
        plan.safeTx.gasPrice,
        plan.safeTx.gasToken,
        plan.safeTx.refundReceiver,
        signatures,
      ],
    }),
  };
}

/**
 * A planned resolve plus the root's assertion, turned into one transaction.
 *
 * The assertion's own challenge is checked against the plan's hash first. That
 * check is what stops an assertion collected for anything else — a login, a
 * session revoke, a *different* intent — from being replayed here: the
 * authenticator signed one hash, and if it is not this Safe transaction's, this
 * refuses instead of handing the chain a signature to reject.
 */
export function buildSafeResolveExecution(
  plan: SafeTransactionPlan,
  ownerAddress: `0x${string}`,
  assertion: WebAuthnAssertionBytes,
): SafeExecution {
  const { challenge } = splitClientData(assertion.clientDataJSON);
  const expected = hashToChallenge(plan.safeTxHash);
  if (challenge !== expected) {
    throw new Error(
      `assertion_not_for_this_safe_tx: the assertion answers ${challenge}, this transaction is ${expected}.`,
    );
  }
  return encodeSafeExecTransaction(
    plan,
    encodeContractSignature(ownerAddress, encodeWebAuthnSignature(assertion)),
  );
}

/**
 * Whether this Safe is really the passkey's, read off the chain.
 *
 * Owning the Safe is the entire authority being exercised, so the check is not
 * "does a Safe exist at the root address" but "is it 1-of-1 owned by the signer
 * this credential implies". A Safe whose owners drifted — or one an operator
 * pointed the workspace at — must not settle intents on the root's behalf.
 */
export async function verifySafeApprover(opts: {
  provider: string;
  safeAddress: `0x${string}`;
  expectedOwner: `0x${string}`;
}): Promise<RootSafeVerification> {
  return verifyRootSafeDeployed(opts);
}

/**
 * The Safe named by the workspace root must be the address the chain is waiting
 * on. Anything else — most importantly an orchestrator's own EOA — is refused
 * by name: an approval settled by a key the product happens to hold is exactly
 * what a Safe root exists to rule out.
 */
export function assertSafeIsAwaitingApprover(
  safeAddress: `0x${string}`,
  awaitingApprover: `0x${string}` | null,
): void {
  if (!awaitingApprover) {
    throw new Error("no_awaiting_approver: this intent is not waiting on anyone.");
  }
  if (awaitingApprover.toLowerCase() !== safeAddress.toLowerCase()) {
    throw new Error(
      `awaiting_approver_is_not_the_root_safe: the chain waits on ${awaitingApprover}, ` +
        `the workspace root Safe is ${safeAddress}.`,
    );
  }
}

export type RelaySafeExecutionOptions = {
  provider: string;
  /** Sender key. Pays gas and authorizes nothing — the passkey did that. */
  privateKey: `0x${string}`;
  /** Chain ids this key may broadcast on; an empty list refuses everything. */
  allowChainIds: readonly number[];
  execution: SafeExecution;
};

export type RelaySafeExecutionResult = {
  sender: `0x${string}`;
  hash: `0x${string}`;
};

/**
 * Broadcast a built `execTransaction`. Same discipline as the root-Safe
 * deployment relayer: no default allowlist, refused before any RPC is reached,
 * and a reverted receipt throws rather than returning something a caller could
 * read as an approval that landed.
 */
export async function relaySafeExecution(
  opts: RelaySafeExecutionOptions,
): Promise<RelaySafeExecutionResult> {
  // Before any RPC: an unconfigured relayer must refuse without first telling
  // an endpoint which chain it was hoping to spend on.
  assertRelayAllowlist(opts.allowChainIds);
  const publicClient = createPublicClient({ transport: http(opts.provider) });
  const chainId = await publicClient.getChainId();
  assertRelayableChain(chainId, opts.allowChainIds);

  const account = privateKeyToAccount(opts.privateKey);
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.provider] } },
  });
  const walletClient = createWalletClient({ account, chain, transport: http(opts.provider) });
  const hash = await walletClient.sendTransaction({
    to: opts.execution.to,
    data: opts.execution.data,
    value: opts.execution.value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`safe_exec_reverted: the Safe approval transaction reverted (${hash}).`);
  }
  return { sender: account.address, hash };
}

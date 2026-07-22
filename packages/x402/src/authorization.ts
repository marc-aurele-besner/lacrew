/**
 * Signing and checking EIP-3009 transfer authorizations (PRD F1.15).
 *
 * The payer signs EIP-712 typed data; the token contract recovers the signer
 * and moves the funds. Because the signature covers the transfer and not the
 * sender, any party can submit it — the "facilitator" in x402 is a relayer and
 * gas payer, never a gatekeeper.
 */

import {
  getAddress,
  hashTypedData,
  hexToBigInt,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Abi,
} from "viem";
import type { Authorization, PaymentRequirements } from "./types.js";

/** The struct USDC and other EIP-3009 tokens hash for a transfer. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type Eip712Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
};

/** Minimal reader shape — satisfied by a viem PublicClient. */
export type ContractReader = {
  readContract: (args: {
    address: `0x${string}`;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>;
};

const TOKEN_METADATA_ABI = [
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "version", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const satisfies Abi;

/**
 * EIP-712 domain for a token. `name`/`version` are read from the contract when
 * the requirements do not carry them: they differ per deployment (Base USDC is
 * "USD Coin" v2, not "USDC"), and a wrong domain produces a signature that
 * fails onchain with no useful error.
 */
export async function resolveDomain(
  client: ContractReader,
  asset: `0x${string}`,
  chainId: number,
  hints?: { name?: string; version?: string },
): Promise<Eip712Domain> {
  const [name, version] = await Promise.all([
    hints?.name ?? (client.readContract({ address: asset, abi: TOKEN_METADATA_ABI as Abi, functionName: "name" }) as Promise<string>),
    hints?.version ?? (client.readContract({ address: asset, abi: TOKEN_METADATA_ABI as Abi, functionName: "version" }) as Promise<string>),
  ]);
  return { name, version, chainId, verifyingContract: getAddress(asset) };
}

/** A random 32-byte authorization nonce. Reuse is rejected by the token. */
export function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export type BuildAuthorizationOptions = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  /** Seconds the authorization stays valid. Default 600. */
  validForSeconds?: number;
  /** Epoch seconds; injectable so tests are not clock-dependent. */
  now?: number;
  nonce?: `0x${string}`;
  /**
   * Earliest block timestamp that may settle. Defaults to 0 — see below.
   */
  validAfter?: bigint;
};

export function buildAuthorization(opts: BuildAuthorizationOptions): Authorization {
  if (opts.value <= 0n) throw new Error("Authorization value must be positive.");
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));
  return {
    from: getAddress(opts.from),
    to: getAddress(opts.to),
    value: opts.value,
    // Valid from epoch by default. Chain time routinely lags the payer's clock
    // (forks, L2 sequencer lag), and a validAfter above the mined block's
    // timestamp reverts with "authorization is not yet valid". It costs no
    // safety: the authorization is still bounded by validBefore and spendable
    // exactly once, since the token burns the nonce.
    validAfter: opts.validAfter ?? 0n,
    validBefore: now + BigInt(opts.validForSeconds ?? 600),
    nonce: opts.nonce ?? randomNonce(),
  };
}

/** Typed-data payload for `signTypedData`. */
export function authorizationTypedData(domain: Eip712Domain, authorization: Authorization) {
  return {
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: authorization,
  };
}

/** Minimal signer shape — satisfied by a viem WalletClient or Account. */
export type TypedDataSigner = {
  signTypedData: (args: {
    domain: Eip712Domain;
    types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
    primaryType: "TransferWithAuthorization";
    message: Authorization;
    account?: unknown;
  }) => Promise<`0x${string}`>;
};

/** Sign an authorization as the payer. */
export async function signAuthorization(
  signer: TypedDataSigner,
  domain: Eip712Domain,
  authorization: Authorization,
): Promise<`0x${string}`> {
  return signer.signTypedData(authorizationTypedData(domain, authorization));
}

export type VerificationResult = { valid: true } | { valid: false; reason: string };

/**
 * Check an authorization before settling: signature, timing, and amount.
 * Advisory — the token re-checks the signature and nonce onchain — but it lets
 * a resource server reject a bad payment without paying gas to learn that.
 */
export async function verifyAuthorization(opts: {
  domain: Eip712Domain;
  authorization: Authorization;
  signature: `0x${string}`;
  requirements: PaymentRequirements;
  /** Epoch seconds; injectable for deterministic tests. */
  now?: number;
}): Promise<VerificationResult> {
  const { authorization: auth, requirements } = opts;
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));

  if (!isAddress(auth.from) || !isAddress(auth.to)) {
    return { valid: false, reason: "authorization has a malformed address" };
  }
  if (getAddress(auth.to) !== getAddress(requirements.payTo)) {
    return { valid: false, reason: `pays ${auth.to}, expected ${requirements.payTo}` };
  }
  if (auth.value > BigInt(requirements.maxAmountRequired)) {
    return {
      valid: false,
      reason: `authorizes ${auth.value}, above the required ${requirements.maxAmountRequired}`,
    };
  }
  if (auth.value <= 0n) {
    return { valid: false, reason: "authorizes a non-positive amount" };
  }
  if (now < auth.validAfter) {
    return { valid: false, reason: "authorization is not yet valid" };
  }
  if (now >= auth.validBefore) {
    return { valid: false, reason: "authorization has expired" };
  }
  if (hexToBigInt(auth.nonce) === 0n) {
    return { valid: false, reason: "authorization nonce is zero" };
  }

  let recovered: `0x${string}`;
  try {
    recovered = await recoverTypedDataAddress({
      ...authorizationTypedData(opts.domain, auth),
      signature: opts.signature,
    });
  } catch {
    return { valid: false, reason: "signature could not be recovered" };
  }
  if (getAddress(recovered) !== getAddress(auth.from)) {
    // Contract payers (Safe, CDP smart accounts) sign via ERC-1271, which does
    // not recover to `from`; those must be verified onchain instead.
    return {
      valid: false,
      reason: `signature recovers to ${recovered}, not the payer ${auth.from}`,
    };
  }
  return { valid: true };
}

/** EIP-1271 magic value returned by `isValidSignature` on success. */
export const ERC1271_MAGIC_VALUE = "0x1626ba7e";

const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
] as const satisfies Abi;

/**
 * Verify a contract payer's signature by asking the payer itself. Safe and
 * smart-account signatures do not recover to `from`, so ecrecover-based checks
 * reject them; the account is the only authority on its own signing rules.
 */
export async function verifyContractAuthorization(
  client: ContractReader,
  domain: Eip712Domain,
  authorization: Authorization,
  signature: `0x${string}`,
): Promise<VerificationResult> {
  const digest = hashTypedData(authorizationTypedData(domain, authorization));
  try {
    const result = (await client.readContract({
      address: authorization.from,
      abi: ERC1271_ABI as Abi,
      functionName: "isValidSignature",
      args: [digest, signature],
    })) as string;
    return result === ERC1271_MAGIC_VALUE
      ? { valid: true }
      : { valid: false, reason: `payer rejected the signature (returned ${result})` };
  } catch {
    // A reverting isValidSignature means rejected just as firmly as a wrong
    // return value — Safe reverts on an unrecognized signer — and a payer with
    // no EIP-1271 at all lands here too. Both are a refusal to pay.
    return {
      valid: false,
      reason: "payer rejected the signature or does not implement EIP-1271",
    };
  }
}

/**
 * Verify against whichever scheme the payer uses, detected from chain. Prefer
 * this when a resource server accepts both EOAs and smart accounts.
 */
export async function verifyAuthorizationAuto(opts: {
  client: ContractReader & { getCode: (a: { address: `0x${string}` }) => Promise<`0x${string}` | undefined> };
  domain: Eip712Domain;
  authorization: Authorization;
  signature: `0x${string}`;
  requirements: PaymentRequirements;
  now?: number;
}): Promise<VerificationResult> {
  // Field checks (recipient, amount, timing) apply to both payer kinds, so run
  // the shared pass first and only swap the signature check.
  const base = await verifyAuthorization(opts);
  if (base.valid) return base;

  const code = await opts.client.getCode({ address: opts.authorization.from });
  if (!code || code === "0x") return base;
  if (!/not the payer|could not be recovered/.test(base.reason)) return base;

  return verifyContractAuthorization(
    opts.client,
    opts.domain,
    opts.authorization,
    opts.signature,
  );
}

/** Stable id for a payment, useful as an audit key. */
export function authorizationId(domain: Eip712Domain, auth: Authorization): `0x${string}` {
  return keccak256(
    toHex(`${domain.chainId}:${domain.verifyingContract}:${auth.from}:${auth.nonce}`),
  );
}

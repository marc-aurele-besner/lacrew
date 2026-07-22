/**
 * Settling an x402 payment onchain (PRD F1.15).
 *
 * Settlement is one call to the token's EIP-3009 `transferWithAuthorization`.
 * No hosted facilitator is involved: the signature authorizes the transfer, so
 * any address can submit it and pay the gas.
 */

import { encodeFunctionData, hexToBytes, type Abi } from "viem";
import type { ContractReader } from "./authorization.js";
import { fromWire, type Authorization, type PaymentPayload } from "./types.js";

export const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

/**
 * EIP-3009 overload taking an opaque signature, which is how EIP-1271 contract
 * payers (Safe, smart accounts) settle. The token calls `isValidSignature` on
 * the payer instead of running ecrecover.
 */
export const EIP3009_BYTES_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/**
 * How the payer authorized the transfer.
 * - `eoa` — ECDSA, split into (v, r, s)
 * - `contract` — EIP-1271, passed through as opaque bytes
 *
 * This is never inferred from signature length: a 1-of-1 Safe signature is also
 * 65 bytes, so guessing would silently produce a garbage `v` and an
 * unattributable revert. Use `resolvePayerType` to detect it from chain state.
 */
export type PayerType = "eoa" | "contract";

export type SettlementTransaction = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

/** Split a 65-byte signature into the (v, r, s) the token expects. */
export function splitSignature(signature: `0x${string}`): {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
} {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 65) {
    throw new Error(
      `Expected a 65-byte ECDSA signature, got ${bytes.length} bytes. ` +
        "Contract payers sign via ERC-1271 and need the bytes-signature variant.",
    );
  }
  const hex = signature.slice(2);
  // Wallets emit v as 0/1 or 27/28; the token requires 27/28.
  const raw = Number.parseInt(hex.slice(128, 130), 16);
  return {
    r: `0x${hex.slice(0, 64)}`,
    s: `0x${hex.slice(64, 128)}`,
    v: raw < 27 ? raw + 27 : raw,
  };
}

/**
 * Build the settlement transaction. Returned rather than broadcast so the
 * caller chooses who relays and pays gas — that party needs no relationship
 * with the payer.
 */
export function buildSettlementTx(
  asset: `0x${string}`,
  authorization: Authorization,
  signature: `0x${string}`,
  payerType: PayerType = "eoa",
): SettlementTransaction {
  const common = [
    authorization.from,
    authorization.to,
    authorization.value,
    authorization.validAfter,
    authorization.validBefore,
    authorization.nonce,
  ] as const;

  if (payerType === "contract") {
    return {
      to: asset,
      data: encodeFunctionData({
        abi: EIP3009_BYTES_ABI as Abi,
        functionName: "transferWithAuthorization",
        args: [...common, signature],
      }),
      value: 0n,
    };
  }

  const { v, r, s } = splitSignature(signature);
  return {
    to: asset,
    data: encodeFunctionData({
      abi: EIP3009_ABI as Abi,
      functionName: "transferWithAuthorization",
      args: [...common, v, r, s],
    }),
    value: 0n,
  };
}

/** Settlement transaction straight from a decoded `X-PAYMENT` payload. */
export function buildSettlementTxFromPayload(
  asset: `0x${string}`,
  payload: PaymentPayload,
  payerType: PayerType = "eoa",
): SettlementTransaction {
  return buildSettlementTx(
    asset,
    fromWire(payload.payload.authorization),
    payload.payload.signature,
    payerType,
  );
}

/** Reader exposing account code — satisfied by a viem PublicClient. */
export type CodeReader = {
  getCode: (args: { address: `0x${string}` }) => Promise<`0x${string}` | undefined>;
};

/**
 * Whether the payer is a contract, and therefore signs via EIP-1271. The wire
 * format carries no payer-type field, so this is read from chain rather than
 * guessed from the signature.
 */
export async function resolvePayerType(
  client: CodeReader,
  payer: `0x${string}`,
): Promise<PayerType> {
  const code = await client.getCode({ address: payer });
  return code && code !== "0x" ? "contract" : "eoa";
}

/**
 * Settlement transaction with the payer type detected from chain — the safe
 * default when a resource server accepts payments from both EOAs and smart
 * accounts.
 */
export async function buildSettlementTxAuto(
  client: CodeReader,
  asset: `0x${string}`,
  payload: PaymentPayload,
): Promise<SettlementTransaction> {
  const payerType = await resolvePayerType(client, payload.payload.authorization.from);
  return buildSettlementTxFromPayload(asset, payload, payerType);
}

/**
 * Whether an authorization was already used or cancelled. The token rejects
 * replays itself, but checking first turns a wasted gas spend into a cheap read.
 */
export async function isAuthorizationUsed(
  client: ContractReader,
  asset: `0x${string}`,
  authorizer: `0x${string}`,
  nonce: `0x${string}`,
): Promise<boolean> {
  return (await client.readContract({
    address: asset,
    abi: EIP3009_ABI as Abi,
    functionName: "authorizationState",
    args: [authorizer, nonce],
  })) as boolean;
}

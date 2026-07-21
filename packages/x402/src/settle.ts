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
): SettlementTransaction {
  const { v, r, s } = splitSignature(signature);
  return {
    to: asset,
    data: encodeFunctionData({
      abi: EIP3009_ABI as Abi,
      functionName: "transferWithAuthorization",
      args: [
        authorization.from,
        authorization.to,
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce,
        v,
        r,
        s,
      ],
    }),
    value: 0n,
  };
}

/** Settlement transaction straight from a decoded `X-PAYMENT` payload. */
export function buildSettlementTxFromPayload(
  asset: `0x${string}`,
  payload: PaymentPayload,
): SettlementTransaction {
  return buildSettlementTx(
    asset,
    fromWire(payload.payload.authorization),
    payload.payload.signature,
  );
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

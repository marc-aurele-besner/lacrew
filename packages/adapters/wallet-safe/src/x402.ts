/**
 * Paying x402 invoices from a Safe (PRD F1.8 + F1.15).
 *
 * This is where the funded, capped seat meets metered spending: the Safe holds
 * the budget, the AllowanceModule caps what a session key may move, and here
 * the Safe itself authorizes an EIP-3009 transfer so a resource server can be
 * paid without the Safe ever holding gas or touching a facilitator.
 *
 * A Safe cannot sign with ecrecover, so it authorizes via EIP-1271: owners sign
 * the Safe-message wrapper, and the token asks the Safe whether the signature
 * is valid. Settlement therefore uses the bytes-signature overload — see
 * `PayerType` in @lacrew/x402.
 */

import type { Authorization, Eip712Domain } from "@lacrew/x402";
import { loadSafeKit, type SafeWalletConfig } from "./safe.js";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type SafeX402SignerConfig = SafeWalletConfig & {
  safeAddress: `0x${string}`;
  /** Owner key that signs on the Safe's behalf. */
  signer: string;
};

/**
 * Sign an EIP-3009 authorization as the Safe.
 *
 * The returned bytes are an EIP-1271 signature, not ECDSA — settle them with
 * `payerType: "contract"`. Note a 1-of-1 Safe signature is also 65 bytes, so
 * the caller must carry the payer type rather than infer it from length.
 *
 * With a threshold above 1 this returns only the signatures collected so far;
 * the token will reject it until enough owners have signed.
 */
export async function signSafeX402Authorization(
  config: SafeX402SignerConfig,
  domain: Eip712Domain,
  authorization: Authorization,
): Promise<`0x${string}`> {
  if (authorization.from.toLowerCase() !== config.safeAddress.toLowerCase()) {
    throw new Error(
      `Authorization pays from ${authorization.from} but this Safe is ${config.safeAddress}.`,
    );
  }
  const Safe = await loadSafeKit();
  const safe = await Safe.init({
    provider: config.provider,
    signer: config.signer,
    safeAddress: config.safeAddress,
  });

  const message = await safe.createMessage({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  } as never);

  const signed = await safe.signMessage(message);
  return signed.encodedSignatures() as `0x${string}`;
}

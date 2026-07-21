/**
 * x402 wire types (PRD F1.15), protocol version 1.
 *
 * A resource server answers HTTP 402 with `PaymentRequirements`; the client
 * returns a `PaymentPayload` in the `X-PAYMENT` header. The payload is an
 * EIP-3009 authorization signed by the payer — it authorizes the *transfer*,
 * not the submitter, which is why anyone can settle it.
 */

export const X402_VERSION = 1;

/** Only "exact" is defined for EVM in protocol v1. */
export type X402Scheme = "exact";

/** Networks this package knows how to settle on. */
export type X402Network = "base" | "base-sepolia";

/**
 * EIP-3009 authorization. Serialized as strings on the wire, which is why the
 * struct is kept separate from the bigint-typed form used for signing.
 */
export type Authorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
};

/** Wire form: every numeric field is a decimal string. */
export type AuthorizationWire = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};

export type PaymentRequirements = {
  scheme: X402Scheme;
  network: X402Network;
  /** Token contract the payment settles in. */
  asset: `0x${string}`;
  /** Largest amount the client may authorize, in the token's smallest unit. */
  maxAmountRequired: string;
  /** Recipient of the funds. */
  payTo: `0x${string}`;
  /** Resource being paid for. */
  resource: string;
  description?: string;
  mimeType?: string;
  /** How long the client's authorization may stay valid, in seconds. */
  maxTimeoutSeconds?: number;
  /** EIP-712 domain hints — `name` and `version` of the token contract. */
  extra?: { name?: string; version?: string } & Record<string, unknown>;
};

export type PaymentPayload = {
  x402Version: typeof X402_VERSION;
  scheme: X402Scheme;
  network: X402Network;
  payload: {
    signature: `0x${string}`;
    authorization: AuthorizationWire;
  };
};

export function toWire(auth: Authorization): AuthorizationWire {
  return {
    from: auth.from,
    to: auth.to,
    value: auth.value.toString(),
    validAfter: auth.validAfter.toString(),
    validBefore: auth.validBefore.toString(),
    nonce: auth.nonce,
  };
}

export function fromWire(auth: AuthorizationWire): Authorization {
  return {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };
}

/**
 * `X-PAYMENT` header value: base64 of the JSON payload.
 * Bigints are already strings on the wire, so JSON.stringify is safe here.
 */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Parse an `X-PAYMENT` header, rejecting anything not shaped like a payload. */
export function decodePaymentHeader(header: string): PaymentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new Error("X-PAYMENT header is not valid base64 JSON.");
  }
  const p = parsed as Partial<PaymentPayload>;
  if (p?.x402Version !== X402_VERSION) {
    throw new Error(`Unsupported x402 version: ${String(p?.x402Version)}.`);
  }
  if (p.scheme !== "exact") {
    throw new Error(`Unsupported x402 scheme: ${String(p.scheme)}.`);
  }
  const auth = p.payload?.authorization;
  if (!p.payload?.signature || !auth?.from || !auth?.to || auth.value === undefined) {
    throw new Error("X-PAYMENT payload is missing signature or authorization fields.");
  }
  return p as PaymentPayload;
}

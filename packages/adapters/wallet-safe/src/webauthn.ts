/**
 * WebAuthn assertion verification for passkey roots (PRD F0.7 / F1.3).
 *
 * `predictPasskeySafe` answers "which address does this credential own"; this
 * answers "did that credential just consent to this exact thing". Both read the
 * same COSE key, so a root proved here is the same root the Safe verifies
 * onchain — and neither path ever sees private key material.
 *
 * Verification is deliberately strict and local: no network, no relying-party
 * service, nothing but the registered public key and the assertion. That is
 * what lets a self-hosted orchestrator check a root proof for itself instead of
 * trusting whoever relayed it.
 */

import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import { coseP256Coordinates } from "./passkey.js";

export type AssertionVerification = { verified: true } | { verified: false; error: string };

export interface WebAuthnAssertion {
  /** base64url `authenticatorData` from the assertion. */
  authenticatorData: string;
  /** base64url `clientDataJSON` from the assertion. */
  clientDataJSON: string;
  /** base64url DER ECDSA signature from the assertion. */
  signature: string;
}

export interface VerifyAssertionInput extends WebAuthnAssertion {
  /** COSE public key recorded at registration (base64url or raw bytes). */
  publicKey: string | Uint8Array;
  /** base64url challenge this assertion must answer. */
  challenge: string;
  /** Relying-party id whose SHA-256 must equal the assertion's rpIdHash. */
  rpId: string;
  /**
   * Origin(s) the ceremony may have been collected at. A single string or a
   * list; anything else is refused rather than pattern-matched.
   */
  origin: string | readonly string[];
  /** Require the authenticator's user-verified flag (defaults to false). */
  requireUserVerification?: boolean;
}

function fromBase64Url(value: string): Uint8Array {
  // Node decodes base64url leniently (it never throws), so the alphabet is
  // checked here; otherwise garbage flows on under a misleading error name.
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("not base64url");
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** Fixed-time compare so a wrong challenge leaks no prefix length. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/**
 * Verify a WebAuthn `navigator.credentials.get()` assertion.
 *
 * Every check that can fail returns a named reason rather than a bare false:
 * an operator whose revoke was refused needs to know whether the origin was
 * wrong, the challenge stale, or the signature bad — three very different
 * situations, only one of which is an attack.
 */
export function verifyWebAuthnAssertion(input: VerifyAssertionInput): AssertionVerification {
  let coordinates: { x: `0x${string}`; y: `0x${string}` };
  try {
    coordinates = coseP256Coordinates(input.publicKey);
  } catch (err) {
    return {
      verified: false,
      error: err instanceof Error ? err.message : "unreadable_public_key",
    };
  }

  let clientDataBytes: Uint8Array;
  let authenticatorData: Uint8Array;
  let signature: Uint8Array;
  try {
    clientDataBytes = fromBase64Url(input.clientDataJSON);
    authenticatorData = fromBase64Url(input.authenticatorData);
    signature = fromBase64Url(input.signature);
  } catch {
    return { verified: false, error: "assertion_not_base64url" };
  }

  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)) as typeof clientData;
  } catch {
    return { verified: false, error: "client_data_not_json" };
  }

  if (clientData.type !== "webauthn.get") {
    return { verified: false, error: "client_data_type_not_get" };
  }

  // Compared as bytes: base64url encoders disagree about padding, and a padding
  // difference is not a wrong challenge.
  if (typeof clientData.challenge !== "string") {
    return { verified: false, error: "client_data_challenge_missing" };
  }
  if (!equalBytes(fromBase64Url(clientData.challenge), fromBase64Url(input.challenge))) {
    return { verified: false, error: "challenge_mismatch" };
  }

  const origins = typeof input.origin === "string" ? [input.origin] : [...input.origin];
  if (typeof clientData.origin !== "string" || !origins.includes(clientData.origin)) {
    return { verified: false, error: "origin_mismatch" };
  }

  if (authenticatorData.length < 37) {
    return { verified: false, error: "authenticator_data_too_short" };
  }
  const rpIdHash = authenticatorData.slice(0, 32);
  if (!equalBytes(rpIdHash, sha256(new TextEncoder().encode(input.rpId)))) {
    return { verified: false, error: "rp_id_mismatch" };
  }
  const flags = authenticatorData[32]!;
  if ((flags & FLAG_USER_PRESENT) === 0) {
    return { verified: false, error: "user_not_present" };
  }
  if (input.requireUserVerification && (flags & FLAG_USER_VERIFIED) === 0) {
    return { verified: false, error: "user_not_verified" };
  }

  // WebAuthn signs `authenticatorData || sha256(clientDataJSON)`; ES256 hashes
  // that with SHA-256 before the curve operation.
  const signed = new Uint8Array(authenticatorData.length + 32);
  signed.set(authenticatorData, 0);
  signed.set(sha256(clientDataBytes), authenticatorData.length);
  const digest = sha256(signed);

  const publicKeyPoint = new Uint8Array(65);
  publicKeyPoint[0] = 0x04;
  publicKeyPoint.set(fromHex32(coordinates.x), 1);
  publicKeyPoint.set(fromHex32(coordinates.y), 33);

  try {
    // Authenticators are not required to produce low-s signatures, and a
    // high-s one is a valid assertion, not a malleability attack: nothing here
    // is replay-protected by signature bytes — the challenge is single-use.
    const parsed = p256.Signature.fromDER(signature);
    // noble/curves 1.9.x returns an ECDSASignature object from `fromDER` and
    // `verify` takes bytes; round-trip through DER before calling verify.
    if (!p256.verify(parsed.toBytes("der"), digest, publicKeyPoint, { lowS: false })) {
      return { verified: false, error: "signature_invalid" };
    }
  } catch {
    return { verified: false, error: "signature_unparseable" };
  }

  return { verified: true };
}

function fromHex32(hex: `0x${string}`): Uint8Array {
  return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
}

/**
 * Session key lifecycle helpers.
 * Off-chain: generates a real ephemeral secp256k1 key (never logged).
 * On-chain: SessionRegistry stores key address + expiry; root/issuer can revoke.
 * TODO: Replace with ERC-4337 session modules (ZeroDev / Rhinestone) in F1.3.
 */

import {
  DEFAULT_SESSION_TTL_MS,
  sessionScopeMask,
  type SessionKey,
  type SessionScope,
} from "@lacrew/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** Monotonic suffix so mock session ids stay unique within a millisecond. */
let mockSessionSeq = 0;

export interface IssueSessionInput {
  agent: `0x${string}`;
  scopes?: SessionScope[];
  ttlMs?: number;
}

export interface IssuedSession extends SessionKey {
  /** Ephemeral private key — keep in-process only; never persist or log. */
  privateKey: `0x${string}`;
  /** Bitmask handed to `SessionRegistry.issue`; what the chain enforces. */
  scopeMask: bigint;
  expiresAtSec: number;
}

/** Create an ephemeral key pair + metadata (not yet registered onchain). */
export function createEphemeralSession(input: IssueSessionInput): IssuedSession {
  const ttl = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const scopes: SessionScope[] = input.scopes ?? ["propose:intent", "spend:whitelist"];
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const expiresAt = Date.now() + ttl;
  return {
    agent: input.agent,
    keyId: "pending",
    keyAddress: account.address,
    expiresAt,
    expiresAtSec: Math.floor(expiresAt / 1000),
    scopes,
    scopeMask: sessionScopeMask(scopes),
    privateKey,
    revoked: false,
  };
}

/** Mock path: opaque UUID without a real key (offline demos). */
export function issueMockSession(input: IssueSessionInput): SessionKey {
  const ttl = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const scopes: SessionScope[] = input.scopes ?? ["propose:intent"];
  return {
    agent: input.agent,
    // Counter as well as clock: two sessions issued in the same millisecond
    // would otherwise share a keyId, which is the handle used to look them up
    // and revoke them.
    keyId: `sess_mock_${Date.now().toString(36)}_${(mockSessionSeq += 1).toString(36)}`,
    expiresAt: Date.now() + ttl,
    scopes,
    revoked: false,
  };
}

/** @deprecated Prefer createEphemeralSession + onchain register, or issueMockSession. */
export function issueSession(input: IssueSessionInput): SessionKey {
  return issueMockSession(input);
}

export function isSessionExpired(session: SessionKey, now = Date.now()): boolean {
  if (session.revoked) return true;
  return now >= session.expiresAt;
}

/** Local revoke marker (pair with onchain SessionRegistry.revoke). */
export function revokeSession(session: SessionKey): SessionKey {
  return { ...session, expiresAt: Date.now() - 1, scopes: [], revoked: true };
}

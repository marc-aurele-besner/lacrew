/**
 * Session key lifecycle helpers.
 * Mocked: issues opaque key ids with TTL; never holds real private keys.
 * TODO: Integrate ERC-4337 session key modules (ZeroDev / Rhinestone / etc.).
 */

import { DEFAULT_SESSION_TTL_MS, type SessionKey } from "@lacrew/core";
import { randomUUID } from "node:crypto";

export interface IssueSessionInput {
  agent: `0x${string}`;
  scopes?: string[];
  ttlMs?: number;
}

export function issueSession(input: IssueSessionInput): SessionKey {
  const ttl = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  return {
    agent: input.agent,
    keyId: `sess_${randomUUID()}`,
    expiresAt: Date.now() + ttl,
    scopes: input.scopes ?? ["propose:intent"],
  };
}

export function isSessionExpired(session: SessionKey, now = Date.now()): boolean {
  return now >= session.expiresAt;
}

/** Mocked revocation: returns a new record flag only. */
// TODO: Call onchain session revoke from the human root / account module.
export function revokeSession(session: SessionKey): SessionKey {
  return { ...session, expiresAt: Date.now() - 1, scopes: [] };
}

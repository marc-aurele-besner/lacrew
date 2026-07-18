/**
 * Optional shared-token auth for the orchestrator HTTP surface.
 * Set LACREW_ORCH_TOKEN to require `Authorization: Bearer <token>` on every
 * route except GET /health; leave unset for open local demos.
 */

import { timingSafeEqual } from "node:crypto";

export function getOrchToken(): string | undefined {
  const raw = process.env.LACREW_ORCH_TOKEN?.trim();
  return raw ? raw : undefined;
}

/** True when the Authorization header carries the expected bearer token. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

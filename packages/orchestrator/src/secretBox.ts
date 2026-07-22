/**
 * Envelope encryption for session private keys at rest (AES-256-GCM).
 *
 * WHY THIS EXISTS: a session key lives only in memory today, so every restart —
 * a deploy, a crash, a file save under `tsx watch` — loses it. The next
 * `propose` throws, and recovering means issuing a fresh onchain session and
 * sponsoring gas for it, per agent. Sealing lets a key survive a restart
 * without ever sitting in Postgres as cleartext.
 *
 * WHAT A SESSION KEY IS: scoped, expiring authority to propose intents on
 * behalf of one agent, bounded onchain by `maxValue`, `allowedTarget` and
 * `scopeMask`, and revocable from the root key path. It is NOT root key
 * material, which never reaches this process at all (see AGENTS.md).
 *
 * THE TRUST BOUNDARY MOVES, IT DOES NOT WIDEN. An attacker holding both
 * `LACREW_SESSION_KEY` and database read access can sign as an agent — within
 * that agent's onchain scopes, until its session expires. That is precisely the
 * authority a running orchestrator already holds; sealing only makes the
 * at-rest copy explicit and rotatable. What it buys is that a database dump
 * alone is not enough.
 *
 * Deliberately implemented here rather than imported from the cloud's
 * `@lacrew.xyz/tenancy`: tenancy depends on `@lacrew/db`, so importing it would
 * invert the dependency and make the OSS orchestrator unbuildable standalone.
 * Key custody is exactly the thing that has to be public and auditable. The
 * envelope shape matches tenancy's so the two can collapse onto one helper.
 *
 * Key management:
 *   - `LACREW_SESSION_KEY` — 32 random bytes, base64. Generate with:
 *     `openssl rand -base64 32`
 *   - `LACREW_SESSION_KEY_PREVIOUS` — optional, tried on decrypt only, so a key
 *     can be rotated without downtime.
 *
 * Losing the key loses the sealed sessions. That is the intended failure mode:
 * the orchestrator re-issues sessions onchain, which costs gas but is correct.
 * It is strictly better than a database dump handing over signing authority.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ENVELOPE_VERSION = 1;

export type SealedSecret = {
  v: number;
  iv: string;
  tag: string;
  ct: string;
};

export class SessionKeyMissingError extends Error {
  constructor() {
    super("session_key_missing");
    this.name = "SessionKeyMissingError";
  }
}

function decodeKey(raw: string, varName: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${varName} must be ${KEY_BYTES} bytes of base64 (got ${key.length})`);
  }
  return key;
}

function parseKey(raw: string | undefined, varName: string): Buffer | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return decodeKey(trimmed, varName);
}

function primaryKey(): Buffer | null {
  return parseKey(process.env.LACREW_SESSION_KEY, "LACREW_SESSION_KEY");
}

function previousKey(): Buffer | null {
  return parseKey(process.env.LACREW_SESSION_KEY_PREVIOUS, "LACREW_SESSION_KEY_PREVIOUS");
}

/**
 * Whether session keys can be sealed at all.
 *
 * False is a supported configuration, not an error: the orchestrator runs
 * normally and simply does not persist keys, so a restart re-issues sessions
 * exactly as it does today. Callers must degrade rather than refuse to boot.
 */
export function sessionSealingAvailable(): boolean {
  return primaryKey() !== null;
}

export function isSealedSecret(value: unknown): value is SealedSecret {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SealedSecret>;
  return (
    typeof v.v === "number" &&
    typeof v.iv === "string" &&
    typeof v.tag === "string" &&
    typeof v.ct === "string"
  );
}

export function seal(plaintext: string): SealedSecret {
  const key = primaryKey();
  if (!key) throw new SessionKeyMissingError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function openWith(sealed: SealedSecret, key: Buffer): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Decrypt, trying the previous key so rotation is seamless.
 *
 * Throws on an unknown envelope version or a failed auth tag: a key that cannot
 * be authenticated must not be silently treated as absent, because "absent"
 * leads the caller to mint a replacement and quietly move on from a row that
 * may have been tampered with.
 */
export function unseal(sealed: SealedSecret): string {
  const key = primaryKey();
  if (!key) throw new SessionKeyMissingError();
  if (sealed.v !== ENVELOPE_VERSION) {
    throw new Error(`unsupported_session_envelope_v${sealed.v}`);
  }
  try {
    return openWith(sealed, key);
  } catch (err) {
    const prev = previousKey();
    if (!prev) throw err;
    return openWith(sealed, prev);
  }
}

/** Seal a session private key for storage. Returns null when sealing is off. */
export function sealSessionKey(privateKey: string): string | null {
  if (!sessionSealingAvailable()) return null;
  return JSON.stringify(seal(privateKey));
}

/**
 * Recover a sealed session key, or null when it cannot be read.
 *
 * Null on any failure — sealing disabled, wrong key, tampered row, malformed
 * JSON — because the caller's correct response to all of them is the same:
 * treat the session as unrecoverable and issue a new one. The reason is logged
 * so a silent decrypt failure is still visible.
 */
export function unsealSessionKey(raw: string | null | undefined): `0x${string}` | null {
  if (!raw || !sessionSealingAvailable()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isSealedSecret(parsed)) return null;
    const key = unseal(parsed);
    return /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : null;
  } catch (err) {
    console.error(
      "[@lacrew/orchestrator] sealed session key could not be read:",
      err instanceof Error ? err.message.split("\n")[0] : err,
    );
    return null;
  }
}

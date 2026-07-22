import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  isSealedSecret,
  seal,
  sealSessionKey,
  SessionKeyMissingError,
  sessionSealingAvailable,
  unseal,
  unsealSessionKey,
} from "./secretBox.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
/** A well-formed session private key: 0x + 64 hex. */
const PK = `0x${"ab".repeat(32)}` as const;

let saved: { primary?: string; previous?: string };

beforeEach(() => {
  saved = {
    primary: process.env.LACREW_SESSION_KEY,
    previous: process.env.LACREW_SESSION_KEY_PREVIOUS,
  };
  process.env.LACREW_SESSION_KEY = KEY_A;
  delete process.env.LACREW_SESSION_KEY_PREVIOUS;
});

afterEach(() => {
  if (saved.primary === undefined) delete process.env.LACREW_SESSION_KEY;
  else process.env.LACREW_SESSION_KEY = saved.primary;
  if (saved.previous === undefined) delete process.env.LACREW_SESSION_KEY_PREVIOUS;
  else process.env.LACREW_SESSION_KEY_PREVIOUS = saved.previous;
});

describe("seal / unseal", () => {
  it("round-trips", () => {
    assert.equal(unseal(seal(PK)), PK);
  });

  it("never produces the same ciphertext twice", () => {
    // Random IV per seal. Identical ciphertext would leak that two agents hold
    // the same key, or that a key was unchanged across a rotation.
    const a = seal(PK);
    const b = seal(PK);
    assert.notEqual(a.ct, b.ct);
    assert.notEqual(a.iv, b.iv);
    assert.equal(unseal(a), unseal(b));
  });

  it("refuses a tampered ciphertext rather than returning garbage", () => {
    const sealed = seal(PK);
    const bytes = Buffer.from(sealed.ct, "base64");
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    assert.throws(() => unseal({ ...sealed, ct: bytes.toString("base64") }));
  });

  it("refuses a tampered auth tag", () => {
    const sealed = seal(PK);
    const tag = Buffer.from(sealed.tag, "base64");
    tag[0] = (tag[0]! ^ 0xff) & 0xff;
    assert.throws(() => unseal({ ...sealed, tag: tag.toString("base64") }));
  });

  it("refuses an unknown envelope version instead of guessing", () => {
    assert.throws(() => unseal({ ...seal(PK), v: 99 }), /unsupported_session_envelope_v99/);
  });

  it("throws a typed error when no key is configured", () => {
    delete process.env.LACREW_SESSION_KEY;
    assert.throws(() => seal(PK), SessionKeyMissingError);
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env.LACREW_SESSION_KEY = Buffer.from("too short").toString("base64");
    assert.throws(() => seal(PK), /must be 32 bytes/);
  });
});

describe("key rotation", () => {
  it("reads a secret sealed under the previous key", () => {
    const sealed = seal(PK);
    // Rotate: yesterday's primary becomes previous.
    process.env.LACREW_SESSION_KEY = KEY_B;
    process.env.LACREW_SESSION_KEY_PREVIOUS = KEY_A;
    assert.equal(unseal(sealed), PK);
  });

  it("fails once the previous key is dropped", () => {
    const sealed = seal(PK);
    process.env.LACREW_SESSION_KEY = KEY_B;
    assert.throws(() => unseal(sealed));
  });
});

describe("sealSessionKey / unsealSessionKey", () => {
  it("round-trips through the string form stored in Postgres", () => {
    const stored = sealSessionKey(PK);
    assert.ok(stored, "sealing is configured");
    assert.equal(unsealSessionKey(stored), PK);
  });

  it("stores no cleartext key material", () => {
    const stored = sealSessionKey(PK)!;
    assert.ok(!stored.includes(PK), "the key must not survive in the envelope");
    assert.ok(!stored.includes(PK.slice(2)), "nor without its 0x prefix");
  });

  it("returns null when sealing is not configured, rather than storing plaintext", () => {
    // Unconfigured is a supported mode: the orchestrator keeps working and
    // simply re-issues sessions after a restart. What it must never do is
    // fall back to writing the key in the clear.
    delete process.env.LACREW_SESSION_KEY;
    assert.equal(sessionSealingAvailable(), false);
    assert.equal(sealSessionKey(PK), null);
    assert.equal(unsealSessionKey("anything"), null);
  });

  it("returns null for unreadable input instead of throwing into boot", () => {
    // Every one of these means the same thing to the caller: this session is
    // unrecoverable, issue a new one. Hydration must not crash the process.
    assert.equal(unsealSessionKey(null), null);
    assert.equal(unsealSessionKey(""), null);
    assert.equal(unsealSessionKey("not json"), null);
    assert.equal(unsealSessionKey(JSON.stringify({ nope: true })), null);
    const wrongKey = sealSessionKey(PK)!;
    process.env.LACREW_SESSION_KEY = KEY_B;
    assert.equal(unsealSessionKey(wrongKey), null);
  });

  it("rejects a decrypted value that is not a private key", () => {
    // Guards against a row resealed with the right key but the wrong content —
    // the caller would otherwise hand it to privateKeyToAccount and throw deep
    // inside boot.
    const stored = JSON.stringify(seal("definitely-not-a-key"));
    assert.equal(unsealSessionKey(stored), null);
  });
});

describe("isSealedSecret", () => {
  it("accepts a real envelope and rejects near-misses", () => {
    assert.equal(isSealedSecret(seal(PK)), true);
    assert.equal(isSealedSecret(null), false);
    assert.equal(isSealedSecret("string"), false);
    assert.equal(isSealedSecret({ v: 1, iv: "a", tag: "b" }), false);
    assert.equal(isSealedSecret({ v: "1", iv: "a", tag: "b", ct: "c" }), false);
  });
});

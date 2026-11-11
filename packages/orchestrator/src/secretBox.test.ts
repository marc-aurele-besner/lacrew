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
const ORG = "acme";
const OTHER_ORG = "globex";
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
    assert.equal(unseal(seal(PK, ORG), ORG), PK);
  });

  it("never produces the same ciphertext twice", () => {
    // Random IV per seal. Identical ciphertext would leak that two agents hold
    // the same key, or that a key was unchanged across a rotation.
    const a = seal(PK, ORG);
    const b = seal(PK, ORG);
    assert.notEqual(a.ct, b.ct);
    assert.notEqual(a.iv, b.iv);
    assert.equal(unseal(a, ORG), unseal(b, ORG));
  });

  it("refuses a tampered ciphertext rather than returning garbage", () => {
    const sealed = seal(PK, ORG);
    const bytes = Buffer.from(sealed.ct, "base64");
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    assert.throws(() => unseal({ ...sealed, ct: bytes.toString("base64") }, ORG));
  });

  it("refuses a tampered auth tag", () => {
    const sealed = seal(PK, ORG);
    const tag = Buffer.from(sealed.tag, "base64");
    tag[0] = (tag[0]! ^ 0xff) & 0xff;
    assert.throws(() => unseal({ ...sealed, tag: tag.toString("base64") }, ORG));
  });

  it("refuses an unknown envelope version instead of guessing", () => {
    assert.throws(
      () => unseal({ ...seal(PK, ORG), v: 99 }, ORG),
      /unsupported_session_envelope_v99/,
    );
  });

  it("throws a typed error when no key is configured", () => {
    delete process.env.LACREW_SESSION_KEY;
    assert.throws(() => seal(PK, ORG), SessionKeyMissingError);
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env.LACREW_SESSION_KEY = Buffer.from("too short").toString("base64");
    assert.throws(() => seal(PK, ORG), /must be 32 bytes/);
  });
});

describe("sealed for one org", () => {
  it("does not open under another org", () => {
    // Same key, same envelope, moved to another org's row: the auth tag covers
    // the org, so it fails rather than handing over the secret.
    const sealed = seal(PK, ORG);
    assert.throws(() => unseal(sealed, OTHER_ORG));
    assert.equal(unseal(sealed, ORG), PK);
  });

  it("does not open under an org id that only resembles it", () => {
    const sealed = seal(PK, ORG);
    for (const near of ["acme ", "ACME", "acm", "acme-2", "default"]) {
      assert.throws(() => unseal(sealed, near), near);
    }
  });

  it("refuses to seal or open for no org at all", () => {
    assert.throws(() => seal(PK, ""), /sealing_needs_an_org/);
    assert.throws(() => unseal(seal(PK, ORG), ""), /sealing_needs_an_org/);
  });

  it("keeps the org out of the envelope", () => {
    assert.deepEqual(Object.keys(seal(PK, ORG)).sort(), ["ct", "iv", "tag", "v"]);
    assert.ok(!JSON.stringify(seal(PK, ORG)).includes(ORG));
  });

  it("no longer reads an envelope that was sealed for nobody in particular", () => {
    assert.throws(() => unseal({ ...seal(PK, ORG), v: 1 }, ORG), /unsupported_session_envelope_v1/);
  });

  it("holds through a key rotation", () => {
    const sealed = seal(PK, ORG);
    process.env.LACREW_SESSION_KEY = KEY_B;
    process.env.LACREW_SESSION_KEY_PREVIOUS = KEY_A;
    assert.equal(unseal(sealed, ORG), PK);
    assert.throws(() => unseal(sealed, OTHER_ORG));
  });

  it("reads back no session key for another org", () => {
    const stored = sealSessionKey(PK, ORG)!;
    assert.equal(unsealSessionKey(stored, ORG), PK);
    assert.equal(unsealSessionKey(stored, OTHER_ORG), null);
  });
});

describe("key rotation", () => {
  it("reads a secret sealed under the previous key", () => {
    const sealed = seal(PK, ORG);
    // Rotate: yesterday's primary becomes previous.
    process.env.LACREW_SESSION_KEY = KEY_B;
    process.env.LACREW_SESSION_KEY_PREVIOUS = KEY_A;
    assert.equal(unseal(sealed, ORG), PK);
  });

  it("fails once the previous key is dropped", () => {
    const sealed = seal(PK, ORG);
    process.env.LACREW_SESSION_KEY = KEY_B;
    assert.throws(() => unseal(sealed, ORG));
  });
});

describe("sealSessionKey / unsealSessionKey", () => {
  it("round-trips through the string form stored in Postgres", () => {
    const stored = sealSessionKey(PK, ORG);
    assert.ok(stored, "sealing is configured");
    assert.equal(unsealSessionKey(stored, ORG), PK);
  });

  it("stores no cleartext key material", () => {
    const stored = sealSessionKey(PK, ORG)!;
    assert.ok(!stored.includes(PK), "the key must not survive in the envelope");
    assert.ok(!stored.includes(PK.slice(2)), "nor without its 0x prefix");
  });

  it("returns null when sealing is not configured, rather than storing plaintext", () => {
    // Unconfigured is a supported mode: the orchestrator keeps working and
    // simply re-issues sessions after a restart. What it must never do is
    // fall back to writing the key in the clear.
    delete process.env.LACREW_SESSION_KEY;
    assert.equal(sessionSealingAvailable(), false);
    assert.equal(sealSessionKey(PK, ORG), null);
    assert.equal(unsealSessionKey("anything", ORG), null);
  });

  it("returns null for unreadable input instead of throwing into boot", () => {
    // Every one of these means the same thing to the caller: this session is
    // unrecoverable, issue a new one. Hydration must not crash the process.
    assert.equal(unsealSessionKey(null, ORG), null);
    assert.equal(unsealSessionKey("", ORG), null);
    assert.equal(unsealSessionKey("not json", ORG), null);
    assert.equal(unsealSessionKey(JSON.stringify({ nope: true }), ORG), null);
    const wrongKey = sealSessionKey(PK, ORG)!;
    process.env.LACREW_SESSION_KEY = KEY_B;
    assert.equal(unsealSessionKey(wrongKey, ORG), null);
  });

  it("rejects a decrypted value that is not a private key", () => {
    // Guards against a row resealed with the right key but the wrong content —
    // the caller would otherwise hand it to privateKeyToAccount and throw deep
    // inside boot.
    const stored = JSON.stringify(seal("definitely-not-a-key", ORG));
    assert.equal(unsealSessionKey(stored, ORG), null);
  });
});

describe("isSealedSecret", () => {
  it("accepts a real envelope and rejects near-misses", () => {
    assert.equal(isSealedSecret(seal(PK, ORG)), true);
    assert.equal(isSealedSecret(null), false);
    assert.equal(isSealedSecret("string"), false);
    assert.equal(isSealedSecret({ v: 1, iv: "a", tag: "b" }), false);
    assert.equal(isSealedSecret({ v: "1", iv: "a", tag: "b", ct: "c" }), false);
  });
});

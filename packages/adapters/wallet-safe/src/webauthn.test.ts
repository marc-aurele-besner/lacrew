import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist";
import { verifyWebAuthnAssertion } from "./webauthn.js";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";

/** CBOR-encode the COSE_Key map a WebAuthn registration would have produced. */
function coseKey(x: Uint8Array, y: Uint8Array): string {
  const bytes: number[] = [];
  // map(5)
  bytes.push(0xa5);
  // 1 (kty): 2 (EC2)
  bytes.push(0x01, 0x02);
  // 3 (alg): -7 (ES256)
  bytes.push(0x03, 0x26);
  // -1 (crv): 1 (P-256)
  bytes.push(0x20, 0x01);
  // -2 (x): bytes(32)
  bytes.push(0x21, 0x58, 0x20, ...x);
  // -3 (y): bytes(32)
  bytes.push(0x22, 0x58, 0x20, ...y);
  return Buffer.from(bytes).toString("base64url");
}

function authenticatorData(rpId: string, flags = 0x05): Uint8Array {
  const data = new Uint8Array(37);
  data.set(new Uint8Array(createHash("sha256").update(rpId).digest()), 0);
  data[32] = flags;
  // signCount — unread here, but the field is 4 bytes and must be present.
  data[36] = 1;
  return data;
}

/** A complete, valid assertion for `challenge`, plus the credential to check it against. */
function assertion(opts: { challenge: string; rpId?: string; origin?: string; flags?: number }) {
  const privateKey = p256.utils.randomPrivateKey();
  const point = p256.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(false);
  const publicKey = coseKey(point.slice(1, 33), point.slice(33, 65));

  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: opts.challenge,
      origin: opts.origin ?? ORIGIN,
    }),
  );
  const authData = authenticatorData(opts.rpId ?? RP_ID, opts.flags ?? 0x05);
  const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
  const digest = createHash("sha256").update(signed).digest();
  const signature = p256.sign(new Uint8Array(digest), privateKey).toDERRawBytes();

  return {
    publicKey,
    authenticatorData: Buffer.from(authData).toString("base64url"),
    clientDataJSON: clientData.toString("base64url"),
    signature: Buffer.from(signature).toString("base64url"),
  };
}

test("a well-formed assertion over the expected challenge verifies", () => {
  const challenge = randomBytes(32).toString("base64url");
  const result = verifyWebAuthnAssertion({
    ...assertion({ challenge }),
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.deepEqual(result, { verified: true });
});

test("an assertion over a different challenge is refused", () => {
  const signedChallenge = randomBytes(32).toString("base64url");
  const result = verifyWebAuthnAssertion({
    ...assertion({ challenge: signedChallenge }),
    challenge: randomBytes(32).toString("base64url"),
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(result.verified, false);
  assert.equal(result.verified === false && result.error, "challenge_mismatch");
});

test("an assertion collected at another origin is refused", () => {
  const challenge = randomBytes(32).toString("base64url");
  const result = verifyWebAuthnAssertion({
    ...assertion({ challenge, origin: "https://evil.example" }),
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(result.verified === false && result.error, "origin_mismatch");
});

test("an assertion scoped to another relying party is refused", () => {
  const challenge = randomBytes(32).toString("base64url");
  const result = verifyWebAuthnAssertion({
    ...assertion({ challenge, rpId: "evil.example" }),
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(result.verified === false && result.error, "rp_id_mismatch");
});

test("a signature from a different credential is refused", () => {
  const challenge = randomBytes(32).toString("base64url");
  const mine = assertion({ challenge });
  const theirs = assertion({ challenge });
  const result = verifyWebAuthnAssertion({
    ...mine,
    // Same ceremony, someone else's key: the one thing a stolen assertion
    // cannot survive.
    publicKey: theirs.publicKey,
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(result.verified === false && result.error, "signature_invalid");
});

test("user presence is required, and user verification only when asked for", () => {
  const challenge = randomBytes(32).toString("base64url");
  const noPresence = verifyWebAuthnAssertion({
    ...assertion({ challenge, flags: 0x00 }),
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(noPresence.verified === false && noPresence.error, "user_not_present");

  const presentOnly = assertion({ challenge, flags: 0x01 });
  assert.deepEqual(
    verifyWebAuthnAssertion({
      ...presentOnly,
      challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    }),
    { verified: true },
  );
  const strict = verifyWebAuthnAssertion({
    ...presentOnly,
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
    requireUserVerification: true,
  });
  assert.equal(strict.verified === false && strict.error, "user_not_verified");
});

test("a non-get ceremony cannot stand in for an assertion", () => {
  const challenge = randomBytes(32).toString("base64url");
  const built = assertion({ challenge });
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN }),
  ).toString("base64url");
  const result = verifyWebAuthnAssertion({
    ...built,
    clientDataJSON: clientData,
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(result.verified === false && result.error, "client_data_type_not_get");
});

test("several allowed origins are accepted, anything else is not", () => {
  const challenge = randomBytes(32).toString("base64url");
  const built = assertion({ challenge, origin: "https://app.lacrew.xyz" });
  assert.deepEqual(
    verifyWebAuthnAssertion({
      ...built,
      challenge,
      rpId: RP_ID,
      origin: [ORIGIN, "https://app.lacrew.xyz"],
    }),
    { verified: true },
  );
  const refused = verifyWebAuthnAssertion({
    ...built,
    challenge,
    rpId: RP_ID,
    origin: [ORIGIN, "https://other.lacrew.xyz"],
  });
  assert.equal(refused.verified === false && refused.error, "origin_mismatch");
});

test("a garbled assertion names what was unreadable rather than failing blank", () => {
  const challenge = randomBytes(32).toString("base64url");
  const built = assertion({ challenge });
  const shortAuth = verifyWebAuthnAssertion({
    ...built,
    authenticatorData: Buffer.from([1, 2, 3]).toString("base64url"),
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(shortAuth.verified === false && shortAuth.error, "authenticator_data_too_short");

  const badSig = verifyWebAuthnAssertion({
    ...built,
    signature: Buffer.from([9, 9, 9]).toString("base64url"),
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(badSig.verified === false && badSig.error, "signature_unparseable");

  const rsaKey = verifyWebAuthnAssertion({
    ...built,
    // kty 3 (RSA): refused, never coerced into a P-256 read.
    publicKey: Buffer.from([0xa1, 0x01, 0x03]).toString("base64url"),
    challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  assert.equal(rsaKey.verified, false);
  assert.match(rsaKey.verified === false ? rsaKey.error : "", /not EC2/);
});

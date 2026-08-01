import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { p256 } from "@noble/curves/nist";
import { privateKeyToAccount } from "viem/accounts";
import { rootChallengeStatement, type RootAuthAction } from "@lacrew/core";
import { createRootAuthSurface, readRootAuthConfig } from "./rootAuth.js";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";

/** The COSE_Key a registration ceremony would have recorded for this key. */
function coseKey(x: Uint8Array, y: Uint8Array): string {
  return Buffer.from([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    0x20,
    ...x,
    0x22,
    0x58,
    0x20,
    ...y,
  ]).toString("base64url");
}

function credential() {
  const privateKey = p256.utils.randomPrivateKey();
  const point =
    p256.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(false);
  return {
    privateKey,
    publicKey: coseKey(point.slice(1, 33), point.slice(33, 65)),
    credentialId: randomBytes(16).toString("base64url"),
  };
}

function assertFor(cred: ReturnType<typeof credential>, challenge: string) {
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN }),
  );
  const authData = new Uint8Array(37);
  authData.set(new Uint8Array(createHash("sha256").update(RP_ID).digest()), 0);
  authData[32] = 0x05;
  const digest = createHash("sha256")
    .update(
      Buffer.concat([
        authData,
        createHash("sha256").update(clientData).digest(),
      ]),
    )
    .digest();
  return {
    kind: "passkey" as const,
    credentialId: cred.credentialId,
    authenticatorData: Buffer.from(authData).toString("base64url"),
    clientDataJSON: clientData.toString("base64url"),
    signature: Buffer.from(
      p256.sign(new Uint8Array(digest), cred.privateKey).toDERRawBytes(),
    ).toString("base64url"),
  };
}

function passkeySurface(
  cred: ReturnType<typeof credential>,
  now?: () => number,
) {
  return createRootAuthSurface({
    config: {
      kind: "passkey",
      credentialId: cred.credentialId,
      publicKey: cred.publicKey,
      rpId: RP_ID,
      origin: ORIGIN,
    },
    ...(now ? { now } : {}),
  });
}

describe("root auth configuration", () => {
  it("is absent until LACREW_ROOT_AUTH names a kind", () => {
    assert.equal(readRootAuthConfig({} as NodeJS.ProcessEnv), null);
    assert.deepEqual(
      readRootAuthConfig({
        LACREW_ROOT_AUTH: "wallet",
        LACREW_ROOT_ADDRESS: "0xabc",
      } as never),
      { kind: "wallet", address: "0xabc" },
    );
  });

  it("refuses a kind it cannot verify rather than falling back to none", () => {
    assert.throws(
      () => readRootAuthConfig({ LACREW_ROOT_AUTH: "yubikey" } as never),
      /not a root account kind/,
    );
  });

  it("reports an incomplete config instead of gating on nothing", async () => {
    const surface = createRootAuthSurface({ config: { kind: "passkey" } });
    assert.equal(surface.required, true);
    assert.match(surface.status().configError ?? "", /credentialId/);
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: "x",
      proof: { kind: "wallet", address: "0x0", signature: "0x0" },
    });
    // 501, not 401: no proof could pass, so this is the deployment's problem.
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.status, 501);
  });

  it("leaves revoke ungated when no root is configured, and says so", async () => {
    const surface = createRootAuthSurface({});
    assert.equal(surface.required, false);
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
    });
    assert.deepEqual(outcome, { ok: true, via: "unconfigured" });
  });
});

describe("passkey root proofs", () => {
  it("accepts an assertion over the challenge it issued", async () => {
    const cred = credential();
    const surface = passkeySurface(cred);
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: assertFor(cred, challenge.challenge),
    });
    assert.deepEqual(outcome, { ok: true, via: "passkey" });
  });

  it("refuses a proof for another session", async () => {
    const cred = credential();
    const surface = passkeySurface(cred);
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "8",
      challenge: challenge.challenge,
      proof: assertFor(cred, challenge.challenge),
    });
    assert.equal(
      outcome.ok === false && outcome.error,
      "challenge_not_for_this_action",
    );
  });

  it("refuses a revoke proof replayed as a rotate", async () => {
    const cred = credential();
    const surface = passkeySurface(cred);
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:rotate",
      subject: "7",
      challenge: challenge.challenge,
      proof: assertFor(cred, challenge.challenge),
    });
    // Rotate re-issues authority; revoke only removes it. Consent to one is
    // not consent to the other.
    assert.equal(
      outcome.ok === false && outcome.error,
      "challenge_not_for_this_action",
    );
  });

  it("burns the challenge, so a captured assertion cannot be replayed", async () => {
    const cred = credential();
    const surface = passkeySurface(cred);
    const challenge = surface.issueChallenge("session:revoke", "7");
    const proof = assertFor(cred, challenge.challenge);
    const args = {
      action: "session:revoke" as RootAuthAction,
      subject: "7",
      challenge: challenge.challenge,
      proof,
    };
    assert.equal((await surface.verify(args)).ok, true);
    const replay = await surface.verify(args);
    assert.equal(
      replay.ok === false && replay.error,
      "challenge_expired_or_unknown",
    );
  });

  it("burns the challenge on a failed attempt too", async () => {
    const cred = credential();
    const stranger = credential();
    const surface = passkeySurface(cred);
    const challenge = surface.issueChallenge("session:revoke", "7");
    const bad = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: {
        ...assertFor(stranger, challenge.challenge),
        credentialId: cred.credentialId,
      },
    });
    assert.equal(bad.ok === false && bad.error, "signature_invalid");
    // Grinding proofs against one live nonce is exactly what a surviving
    // challenge would allow.
    const retry = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: assertFor(cred, challenge.challenge),
    });
    assert.equal(
      retry.ok === false && retry.error,
      "challenge_expired_or_unknown",
    );
  });

  it("refuses an unknown credential before it looks at the signature", async () => {
    const cred = credential();
    const surface = passkeySurface(cred);
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: {
        ...assertFor(cred, challenge.challenge),
        credentialId: "someone-else",
      },
    });
    assert.equal(outcome.ok === false && outcome.error, "unknown_credential");
  });

  it("expires a challenge nobody answered", async () => {
    const cred = credential();
    let clock = 1_000_000;
    const surface = createRootAuthSurface({
      config: {
        kind: "passkey",
        credentialId: cred.credentialId,
        publicKey: cred.publicKey,
        rpId: RP_ID,
        origin: ORIGIN,
      },
      challengeTtlSec: 60,
      now: () => clock,
    });
    const challenge = surface.issueChallenge("session:revoke", "7");
    clock += 61_000;
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: assertFor(cred, challenge.challenge),
    });
    assert.equal(
      outcome.ok === false && outcome.error,
      "challenge_expired_or_unknown",
    );
  });

  it("refuses a wallet signature when the root is a passkey", async () => {
    const cred = credential();
    const surface = passkeySurface(cred);
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: { kind: "wallet", address: "0x1", signature: "0x2" },
    });
    assert.equal(outcome.ok === false && outcome.error, "root_is_a_passkey");
  });

  it("demands a proof rather than assuming consent from the request alone", async () => {
    const surface = passkeySurface(credential());
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
    });
    assert.equal(outcome.ok === false && outcome.error, "root_proof_required");
    assert.equal(outcome.ok === false && outcome.status, 401);
  });
});

describe("wallet root proofs", () => {
  const key =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const account = privateKeyToAccount(key);

  it("accepts a personal_sign over the challenge statement", async () => {
    const surface = createRootAuthSurface({
      config: { kind: "wallet", address: account.address },
      chainId: () => 31337,
    });
    const challenge = surface.issueChallenge("session:revoke", "7");
    assert.equal(
      challenge.statement,
      rootChallengeStatement({
        action: "session:revoke",
        subject: "7",
        challenge: challenge.challenge,
        chainId: 31337,
      }),
    );
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: {
        kind: "wallet",
        address: account.address,
        signature: await account.signMessage({ message: challenge.statement }),
      },
    });
    assert.deepEqual(outcome, { ok: true, via: "wallet" });
  });

  it("refuses a signature from any other address", async () => {
    const stranger = privateKeyToAccount(
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    );
    const surface = createRootAuthSurface({
      config: { kind: "wallet", address: account.address },
    });
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: {
        kind: "wallet",
        address: stranger.address,
        signature: await stranger.signMessage({ message: challenge.statement }),
      },
    });
    assert.equal(
      outcome.ok === false && outcome.error,
      "signature_not_from_root",
    );
  });

  it("refuses a signature over some other statement", async () => {
    const surface = createRootAuthSurface({
      config: { kind: "wallet", address: account.address },
    });
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: {
        kind: "wallet",
        address: account.address,
        signature: await account.signMessage({ message: "gm" }),
      },
    });
    assert.equal(
      outcome.ok === false && outcome.error,
      "signature_not_from_root",
    );
  });

  it("refuses a configured address the chain does not call root", async () => {
    const surface = createRootAuthSurface({
      config: { kind: "wallet", address: account.address },
      humanRoot: async () => "0x000000000000000000000000000000000000dEaD",
    });
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: {
        kind: "wallet",
        address: account.address,
        signature: await account.signMessage({ message: challenge.statement }),
      },
    });
    // A proof from an address SessionRegistry does not recognise authorizes a
    // transaction that would revert — a deployment fault, not a bad signature.
    assert.equal(outcome.ok === false && outcome.status, 501);
    assert.match(outcome.ok === false ? outcome.error : "", /not_onchain_root/);
  });

  it("still verifies when the chain's root cannot be read", async () => {
    const surface = createRootAuthSurface({
      config: { kind: "wallet", address: account.address },
      humanRoot: async () => {
        throw new Error("rpc down");
      },
    });
    const challenge = surface.issueChallenge("session:revoke", "7");
    const outcome = await surface.verify({
      action: "session:revoke",
      subject: "7",
      challenge: challenge.challenge,
      proof: {
        kind: "wallet",
        address: account.address,
        signature: await account.signMessage({ message: challenge.statement }),
      },
    });
    // An unreachable RPC must not be the thing that stops an operator revoking
    // a key; the signature is still checked against the configured root.
    assert.deepEqual(outcome, { ok: true, via: "wallet" });
  });
});

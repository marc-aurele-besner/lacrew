/**
 * Safe-root approval tests (F2.6 / F1.3).
 *
 * The encoding, the challenge binding and the refusals run everywhere. The
 * end-to-end loop needs the canonical Safe singletons and passkey module, so it
 * runs on a local anvil forking a chain that has them:
 *
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   SAFE_FORK_RPC=http://127.0.0.1:8546 \
 *   SAFE_FORK_PK=<an anvil dev key> pnpm --filter @lacrew/adapter-wallet-safe test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { p256 } from "@noble/curves/nist";
import { decodeAbiParameters, decodeFunctionData, parseAbi } from "viem";
import {
  assertSafeIsAwaitingApprover,
  buildSafeResolveExecution,
  encodeContractSignature,
  encodeEscalationResolve,
  encodeWebAuthnSignature,
  escalationResolveAbi,
  hashToChallenge,
  normalizedSignature,
  relaySafeExecution,
  splitClientData,
  type SafeResolvePlan,
} from "./index.js";

const SAFE = "0x1111111111111111111111111111111111111111" as const;
const ROUTER = "0x2222222222222222222222222222222222222222" as const;
const OWNER = "0x3333333333333333333333333333333333333333" as const;
const SAFE_TX_HASH = `0x${"ab".repeat(32)}` as const;

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function b64url(value: string | Uint8Array): string {
  return Buffer.from(value as never).toString("base64url");
}

/** authenticatorData with a caller-chosen flag byte; 37 bytes is the minimum. */
function authenticatorData(flags: number): Uint8Array {
  const bytes = new Uint8Array(37);
  bytes[32] = flags;
  return bytes;
}

function clientDataJson(challenge: string, fields = '"origin":"https://app.lacrew.xyz"'): string {
  return `{"type":"webauthn.get","challenge":"${challenge}",${fields}}`;
}

/** A real P-256 signature over arbitrary bytes, so DER parsing is exercised. */
function signBytes(privateKey: KeyObject, message: Uint8Array): string {
  const signer = createSign("sha256");
  signer.update(message);
  return b64url(new Uint8Array(signer.sign(privateKey)));
}

function assertion(challenge: string, opts: { flags?: number; fields?: string } = {}) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const json = clientDataJson(challenge, opts.fields);
  return {
    authenticatorData: b64url(authenticatorData(opts.flags ?? 0x05)),
    clientDataJSON: b64url(json),
    signature: signBytes(privateKey, new TextEncoder().encode(json)),
  };
}

function plan(overrides: Partial<SafeResolvePlan> = {}): SafeResolvePlan {
  return {
    safeAddress: SAFE,
    intentId: "7",
    approved: true,
    safeTx: {
      to: ROUTER,
      value: 0n,
      data: encodeEscalationResolve(7n, true),
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: 3n,
    },
    safeTxHash: SAFE_TX_HASH,
    ...overrides,
  };
}

test("the Safe executes the router's own resolve call", () => {
  const { functionName, args } = decodeFunctionData({
    abi: escalationResolveAbi,
    data: encodeEscalationResolve("7", false),
  });
  assert.equal(functionName, "resolve");
  assert.deepEqual(args, [7n, false]);
});

test("client data splits into the challenge and the fields Safe rebuilds", () => {
  const parts = splitClientData(b64url(clientDataJson("abc", '"origin":"https://x","crossOrigin":false')));
  assert.equal(parts.challenge, "abc");
  // Everything after the challenge member, minus the braces: what the contract
  // is handed so it can rebuild byte-identical client data.
  assert.equal(parts.clientDataFields, '"origin":"https://x","crossOrigin":false');
});

test("client data the Safe could not rebuild is refused by name", () => {
  // Field order is fixed by the WebAuthn serialization rules; anything else
  // hashes differently onchain, and failing here beats failing as a Safe revert.
  assert.throws(
    () => splitClientData(b64url('{"challenge":"abc","type":"webauthn.get"}')),
    /client_data_not_safe_encodable/,
  );
  // No trailing fields at all: Safe's template always emits a comma after the
  // challenge, so this could never round-trip.
  assert.throws(
    () => splitClientData(b64url('{"type":"webauthn.get","challenge":"abc"}')),
    /client_data_not_safe_encodable/,
  );
});

test("a high-s signature is normalised rather than passed through", () => {
  // Authenticators are not required to produce low-s and several do not, so
  // build the high-s twin of a real signature explicitly: (r, s) and (r, n - s)
  // are both valid, and only one of them satisfies a strict verifier.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const low = normalizedSignature(signBytes(privateKey, new TextEncoder().encode("approve")));
  assert.ok(low.s <= P256_ORDER / 2n);
  const high = new p256.Signature(low.r, P256_ORDER - low.s);
  assert.ok(high.s > P256_ORDER / 2n, "the twin must actually be the high one");

  const normalised = normalizedSignature(high.toDERRawBytes());
  assert.equal(normalised.r, low.r);
  assert.equal(normalised.s, low.s);
});

test("an unparseable signature is refused before anything is encoded", () => {
  assert.throws(() => normalizedSignature(b64url("not-der")), /signature_unparseable/);
});

test("the encoded WebAuthn signature is what the Safe signer decodes", () => {
  const a = assertion("abc", { fields: '"origin":"https://app.lacrew.xyz"' });
  const [authData, fields, r, s] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    encodeWebAuthnSignature(a),
  );
  assert.equal(authData, `0x${Buffer.from(authenticatorData(0x05)).toString("hex")}`);
  assert.equal(fields, '"origin":"https://app.lacrew.xyz"');
  const expected = normalizedSignature(a.signature);
  assert.equal(r, expected.r);
  assert.equal(s, expected.s);
});

test("an assertion without user verification is refused, not sent", () => {
  // The Safe's signer contract demands the UV flag. A "preferred" ceremony that
  // skipped it passes every off-chain check and then reverts inside
  // execTransaction — an approval that reads as granted and moved nothing.
  assert.throws(
    () => encodeWebAuthnSignature(assertion("abc", { flags: 0x01 })),
    /user_not_verified/,
  );
});

test("the contract signature frames the owner, the offset, and the length", () => {
  const encoded = encodeContractSignature(OWNER, "0xdeadbeef");
  assert.equal(
    encoded,
    "0x" +
      "0".repeat(24) +
      OWNER.slice(2) +
      (65).toString(16).padStart(64, "0") +
      "00" +
      (4).toString(16).padStart(64, "0") +
      "deadbeef",
  );
  // 65 bytes of static entry, then a 32-byte length, then the body.
  assert.equal((encoded.length - 2) / 2, 65 + 32 + 4);
});

test("an assertion collected for anything else cannot settle this transaction", () => {
  // The authenticator signed one hash. If it is not this Safe transaction's,
  // the signature is for a different consent — a login, a revoke, another
  // intent — and replaying it here is exactly what this refuses.
  assert.throws(
    () => buildSafeResolveExecution(plan(), OWNER, assertion("some-other-challenge")),
    /assertion_not_for_this_safe_tx/,
  );
});

test("the matching assertion produces an execTransaction against the Safe", () => {
  const p = plan();
  const execution = buildSafeResolveExecution(p, OWNER, assertion(hashToChallenge(p.safeTxHash)));
  assert.equal(execution.to, SAFE);
  assert.equal(execution.value, 0n);
  const { functionName, args } = decodeFunctionData({
    abi: parseAbi([
      "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
    ]),
    data: execution.data,
  });
  assert.equal(functionName, "execTransaction");
  // The Safe calls the router with the resolve payload, as a plain CALL, with
  // every gas field zero so a reverted resolve reverts the whole transaction.
  assert.equal(args![0], ROUTER);
  assert.equal(args![2], encodeEscalationResolve(7n, true));
  assert.equal(args![3], 0);
  assert.deepEqual([args![4], args![5], args![6]], [0n, 0n, 0n]);
});

test("only the root Safe may settle an intent the chain waits on", () => {
  assert.doesNotThrow(() => assertSafeIsAwaitingApprover(SAFE, SAFE));
  // Case is display, not identity.
  assert.doesNotThrow(() => assertSafeIsAwaitingApprover(SAFE, SAFE.toUpperCase() as `0x${string}`));
  // The orchestrator's own key standing in for the Safe is the substitution
  // this whole path exists to rule out.
  assert.throws(
    () => assertSafeIsAwaitingApprover(SAFE, OWNER),
    /awaiting_approver_is_not_the_root_safe/,
  );
  assert.throws(() => assertSafeIsAwaitingApprover(SAFE, null), /no_awaiting_approver/);
});

test("an unconfigured relayer refuses before it reaches an RPC", async () => {
  // The RPC is deliberately unroutable: reaching it at all would be the bug.
  await assert.rejects(
    relaySafeExecution({
      provider: "http://127.0.0.1:1",
      privateKey: `0x${"11".repeat(32)}`,
      allowChainIds: [],
      execution: { to: SAFE, data: "0x", value: 0n },
    }),
    /explicit chain allowlist/,
  );
});

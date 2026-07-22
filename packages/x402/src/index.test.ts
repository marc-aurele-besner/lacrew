/**
 * Offline protocol tests — wire format, signing, and verification. No chain
 * access; settlement itself is covered in settle.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  USDC,
  authorizationId,
  buildAuthorization,
  buildSettlementTx,
  resolvePayerType,
  createPaymentRequirements,
  decodePaymentHeader,
  encodePaymentHeader,
  fromWire,
  networkForChainId,
  randomNonce,
  signAuthorization,
  splitSignature,
  toWire,
  verifyAuthorization,
  X402_VERSION,
  type Authorization,
  type Eip712Domain,
  type PaymentPayload,
} from "./index.js";

const NOW = 1_800_000_000;
const payee = "0x4444444444444444444444444444444444444444" as const;
const account = privateKeyToAccount(generatePrivateKey());

const domain: Eip712Domain = {
  name: USDC.base.name,
  version: USDC.base.version,
  chainId: USDC.base.chainId,
  verifyingContract: USDC.base.address,
};

const requirements = createPaymentRequirements({
  network: "base",
  payTo: payee,
  maxAmountRequired: 1_000_000n, // 1 USDC
  resource: "https://api.example.com/report",
});

function authFor(overrides: Partial<Authorization> = {}): Authorization {
  return {
    ...buildAuthorization({
      from: account.address,
      to: payee,
      value: 1_000_000n,
      now: NOW,
    }),
    ...overrides,
  };
}

async function signed(auth: Authorization) {
  return signAuthorization(account, domain, auth);
}

test("requirements carry the token's real EIP-712 domain hints", () => {
  // Base mainnet USDC is "USD Coin", not "USDC" — signing the wrong name
  // yields a signature that fails onchain with no useful error.
  assert.equal(requirements.extra?.name, "USD Coin");
  assert.equal(requirements.extra?.version, "2");
  assert.equal(requirements.asset, USDC.base.address);
  assert.equal(requirements.scheme, "exact");
  assert.notEqual(USDC.base.name, USDC["base-sepolia"].name);
});

test("network lookup is bidirectional", () => {
  assert.equal(networkForChainId(8453), "base");
  assert.equal(networkForChainId(84532), "base-sepolia");
  assert.throws(() => networkForChainId(1), /No x402 network configured/);
});

test("wire encoding round-trips without losing precision", () => {
  const auth = authFor({ value: 2n ** 64n + 7n });
  assert.deepEqual(fromWire(toWire(auth)), auth);
});

test("X-PAYMENT header round-trips", async () => {
  const auth = authFor();
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: "base",
    payload: { signature: await signed(auth), authorization: toWire(auth) },
  };
  const decoded = decodePaymentHeader(encodePaymentHeader(payload));
  assert.deepEqual(decoded, payload);
});

test("malformed X-PAYMENT headers are rejected", () => {
  assert.throws(() => decodePaymentHeader("not-base64-json"), /valid base64 JSON/);
  const wrongVersion = Buffer.from(JSON.stringify({ x402Version: 99 })).toString("base64");
  assert.throws(() => decodePaymentHeader(wrongVersion), /Unsupported x402 version/);
  const wrongScheme = Buffer.from(
    JSON.stringify({ x402Version: 1, scheme: "upto" }),
  ).toString("base64");
  assert.throws(() => decodePaymentHeader(wrongScheme), /Unsupported x402 scheme/);
  const noSig = Buffer.from(
    JSON.stringify({ x402Version: 1, scheme: "exact", payload: {} }),
  ).toString("base64");
  assert.throws(() => decodePaymentHeader(noSig), /missing signature/);
});

test("a well-formed authorization verifies", async () => {
  const auth = authFor();
  const result = await verifyAuthorization({
    domain,
    authorization: auth,
    signature: await signed(auth),
    requirements,
    now: NOW,
  });
  assert.deepEqual(result, { valid: true });
});

test("validAfter defaults to 0 so chain-clock lag cannot reject it", () => {
  const auth = buildAuthorization({
    from: account.address,
    to: payee,
    value: 1n,
    now: NOW,
  });
  // A validAfter near the payer's clock reverts on any chain whose block
  // timestamp trails it; the nonce and validBefore still bound the payment.
  assert.equal(auth.validAfter, 0n);
  assert.equal(auth.validBefore, BigInt(NOW) + 600n);
  assert.equal(
    buildAuthorization({
      from: account.address,
      to: payee,
      value: 1n,
      now: NOW,
      validAfter: 123n,
    }).validAfter,
    123n,
    "callers can still pin a start time",
  );
});

test("payment to the wrong recipient is rejected", async () => {
  const auth = authFor({ to: "0x9999999999999999999999999999999999999999" });
  const result = await verifyAuthorization({
    domain,
    authorization: auth,
    signature: await signed(auth),
    requirements,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.valid === false ? result.reason : "", /expected/);
});

test("overpaying beyond the requirement is rejected", async () => {
  const auth = authFor({ value: 5_000_000n });
  const result = await verifyAuthorization({
    domain,
    authorization: auth,
    signature: await signed(auth),
    requirements,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.valid === false ? result.reason : "", /above the required/);
});

test("expired and not-yet-valid authorizations are rejected", async () => {
  const auth = authFor();
  const sig = await signed(auth);
  const expired = await verifyAuthorization({
    domain,
    authorization: auth,
    signature: sig,
    requirements,
    now: NOW + 10_000,
  });
  assert.equal(expired.valid, false);
  assert.match(expired.valid === false ? expired.reason : "", /expired/);

  const notYet = authFor({ validAfter: BigInt(NOW) + 5_000n });
  const early = await verifyAuthorization({
    domain,
    authorization: notYet,
    signature: await signed(notYet),
    requirements,
    now: NOW,
  });
  assert.equal(early.valid, false);
  assert.match(early.valid === false ? early.reason : "", /not yet valid/);
});

test("a signature from someone other than the payer is rejected", async () => {
  const auth = authFor();
  const impostor = privateKeyToAccount(generatePrivateKey());
  const result = await verifyAuthorization({
    domain,
    authorization: auth,
    signature: await signAuthorization(impostor, domain, auth),
    requirements,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.valid === false ? result.reason : "", /not the payer/);
});

test("a signature bound to a different domain is rejected", async () => {
  // The same authorization signed for Base Sepolia must not settle on Base.
  const auth = authFor();
  const otherDomain: Eip712Domain = {
    name: USDC["base-sepolia"].name,
    version: USDC["base-sepolia"].version,
    chainId: USDC["base-sepolia"].chainId,
    verifyingContract: USDC["base-sepolia"].address,
  };
  const result = await verifyAuthorization({
    domain,
    authorization: auth,
    signature: await signAuthorization(account, otherDomain, auth),
    requirements,
    now: NOW,
  });
  assert.equal(result.valid, false);
});

test("tampering with the amount after signing is rejected", async () => {
  const auth = authFor();
  const sig = await signed(auth);
  const result = await verifyAuthorization({
    domain,
    authorization: { ...auth, value: 1n },
    signature: sig,
    requirements,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.valid === false ? result.reason : "", /not the payer/);
});

test("a zero nonce is rejected", async () => {
  const auth = authFor({ nonce: `0x${"0".repeat(64)}` });
  const result = await verifyAuthorization({
    domain,
    authorization: auth,
    signature: await signed(auth),
    requirements,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.valid === false ? result.reason : "", /nonce is zero/);
});

test("nonces do not repeat", () => {
  const seen = new Set(Array.from({ length: 256 }, () => randomNonce()));
  assert.equal(seen.size, 256);
});

test("signature splitting normalizes v and rejects wrong lengths", async () => {
  const auth = authFor();
  const { v, r, s } = splitSignature(await signed(auth));
  assert.ok(v === 27 || v === 28, `v should be 27/28, got ${v}`);
  assert.match(r, /^0x[0-9a-f]{64}$/);
  assert.match(s, /^0x[0-9a-f]{64}$/);
  assert.throws(() => splitSignature("0xdeadbeef"), /65-byte/);
});

test("authorization id is stable and distinct per nonce", () => {
  const auth = authFor();
  assert.equal(authorizationId(domain, auth), authorizationId(domain, auth));
  assert.notEqual(
    authorizationId(domain, auth),
    authorizationId(domain, { ...auth, nonce: randomNonce() }),
  );
});

test("a non-positive authorization value is refused at build time", () => {
  assert.throws(
    () => buildAuthorization({ from: account.address, to: payee, value: 0n }),
    /must be positive/,
  );
});

test("settlement picks the overload from the payer type, never signature length", async () => {
  const auth = authFor();
  const sig = await signed(auth);
  // A 1-of-1 Safe signature is also 65 bytes, so length cannot disambiguate —
  // guessing would produce a garbage `v` and an unattributable revert.
  const eoa = buildSettlementTx(USDC.base.address, auth, sig);
  const contract = buildSettlementTx(USDC.base.address, auth, sig, "contract");
  assert.match(eoa.data, /^0xe3ee160e/); // (…, uint8 v, bytes32 r, bytes32 s)
  assert.match(contract.data, /^0xcf092995/); // (…, bytes signature)
  assert.notEqual(eoa.data, contract.data);
});

test("a contract signature of any length passes through unsplit", () => {
  const auth = authFor();
  // Multi-owner Safe signatures exceed 65 bytes; the EOA path would reject
  // this, the contract path must forward it verbatim.
  const long = `0x${"ab".repeat(130)}` as `0x${string}`;
  assert.throws(() => buildSettlementTx(USDC.base.address, auth, long), /65-byte/);
  const tx = buildSettlementTx(USDC.base.address, auth, long, "contract");
  assert.ok(tx.data.includes("ab".repeat(130)), "signature must be forwarded intact");
});

test("payer type is read from account code", async () => {
  const codes: Record<string, `0x${string}`> = {
    "0x1111111111111111111111111111111111111111": "0x",
    "0x2222222222222222222222222222222222222222": "0x60806040",
  };
  const client = {
    getCode: async ({ address }: { address: `0x${string}` }) => codes[address.toLowerCase()],
  };
  assert.equal(
    await resolvePayerType(client, "0x1111111111111111111111111111111111111111"),
    "eoa",
  );
  assert.equal(
    await resolvePayerType(client, "0x2222222222222222222222222222222222222222"),
    "contract",
  );
});

/**
 * Passkey-owner tests. COSE parsing and verifier packing run everywhere; the
 * chain-touching cases need the canonical Safe passkey module, so they skip
 * unless SAFE_FORK_RPC points at a fork of a chain that has it (see
 * index.test.ts for the anvil incantation).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildPasskeyOwnerDeployTx,
  connectSafeWallet,
  coseP256Coordinates,
  deployPasskeySafe,
  packVerifiers,
  passkeyModuleAddresses,
  predictPasskeyOwner,
  predictPasskeySafe,
} from "./index.js";

/** CBOR-encode the small COSE map shape a WebAuthn attestation produces. */
function encodeCoseKey(entries: Array<[number, number | Uint8Array]>): Uint8Array {
  const out: number[] = [0xa0 + entries.length];
  const pushInt = (n: number) => {
    if (n >= 0) {
      if (n < 24) out.push(n);
      else out.push(24, n);
    } else {
      const m = -1 - n;
      if (m < 24) out.push(0x20 + m);
      else out.push(0x38, m);
    }
  };
  for (const [key, value] of entries) {
    pushInt(key);
    if (typeof value === "number") {
      pushInt(value);
    } else {
      out.push(0x58, value.length);
      out.push(...value);
    }
  }
  return new Uint8Array(out);
}

/** A genuine P-256 key so coordinates are real curve points, not fixtures. */
function realP256(): { x: Uint8Array; y: Uint8Array } {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    x: new Uint8Array(Buffer.from(jwk.x!, "base64url")),
    y: new Uint8Array(Buffer.from(jwk.y!, "base64url")),
  };
}

const VERIFIER = "0xc2b78104907F722DABAc4C69f826a522B2754De4" as const;

test("COSE ES256 key round-trips to its coordinates", () => {
  const { x, y } = realP256();
  const cose = encodeCoseKey([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
  const coords = coseP256Coordinates(cose);
  assert.equal(coords.x, `0x${Buffer.from(x).toString("hex")}`);
  assert.equal(coords.y, `0x${Buffer.from(y).toString("hex")}`);
  // The base64url form (how the cloud stores it) decodes identically.
  const b64 = Buffer.from(cose).toString("base64url");
  assert.deepEqual(coseP256Coordinates(b64), coords);
});

test("foreign key kinds are refused, never coerced", () => {
  const { x, y } = realP256();
  const ec2: Array<[number, number | Uint8Array]> = [
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, x],
    [-3, y],
  ];
  // RSA (kty 3, alg RS256): a WebAuthn key this module must not pretend to own.
  assert.throws(
    () =>
      coseP256Coordinates(
        encodeCoseKey([
          [1, 3],
          [3, -257],
        ]),
      ),
    /not EC2/,
  );
  // Wrong curve (P-384 is crv 2).
  assert.throws(
    () => coseP256Coordinates(encodeCoseKey(ec2.map(([k, v]) => [k, k === -1 ? 2 : v]))),
    /not P-256/,
  );
  // Wrong algorithm on an EC2 key.
  assert.throws(
    () => coseP256Coordinates(encodeCoseKey(ec2.map(([k, v]) => [k, k === 3 ? -257 : v]))),
    /not ES256/,
  );
  // Truncated coordinate.
  assert.throws(
    () => coseP256Coordinates(encodeCoseKey(ec2.map(([k, v]) => [k, k === -2 ? x.slice(1) : v]))),
    /31 bytes, expected 32/,
  );
  // Not CBOR at all.
  assert.throws(() => coseP256Coordinates(new Uint8Array([0xff, 0x00])), /CBOR/);
});

test("verifiers pack as precompile over fallback", () => {
  assert.equal(packVerifiers(VERIFIER, 0), BigInt(VERIFIER));
  assert.equal(packVerifiers(VERIFIER, 0x0100), (0x0100n << 160n) | BigInt(VERIFIER));
  assert.throws(() => packVerifiers(VERIFIER, 0x10000), /2-byte field/);
});

test("canonical module addresses resolve for known chains and refuse unknown ones", () => {
  const base = passkeyModuleAddresses(8453);
  assert.match(base.signerFactory, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(base.p256Verifier, VERIFIER);
  assert.throws(() => passkeyModuleAddresses(31337), /no canonical deployment on chain 31337/);
});

test("the signer deploy tx targets the factory with createSigner", () => {
  const { x, y } = realP256();
  const tx = buildPasskeyOwnerDeployTx(8453, {
    x: `0x${Buffer.from(x).toString("hex")}` as `0x${string}`,
    y: `0x${Buffer.from(y).toString("hex")}` as `0x${string}`,
  });
  assert.equal(tx.to, passkeyModuleAddresses(8453).signerFactory);
  assert.equal(tx.value, 0n);
  // createSigner(uint256,uint256,uint176) selector.
  assert.equal(tx.data.slice(0, 10), "0x0d2f0489");
});

const rpc = process.env.SAFE_FORK_RPC;
const pk = process.env.SAFE_FORK_PK;
const skipChain = !rpc;

test(
  "fork: a passkey predicts one owner and one Safe, deterministically",
  { skip: skipChain },
  async () => {
    const client = createPublicClient({ transport: http(rpc!) });
    const { x, y } = realP256();
    const cose = encodeCoseKey([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]);

    const owner = await predictPasskeyOwner(client, cose);
    assert.match(owner.address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(owner.deployed, false);

    // Same credential → same owner; a different credential → a different owner.
    const again = await predictPasskeyOwner(client, cose);
    assert.equal(again.address, owner.address);
    const other = realP256();
    const otherCose = encodeCoseKey([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, other.x],
      [-3, other.y],
    ]);
    assert.notEqual((await predictPasskeyOwner(client, otherCose)).address, owner.address);

    const predicted = await predictPasskeySafe(client, {
      provider: rpc!,
      publicKey: cose,
      saltNonce: "passkey-root-test",
    });
    assert.equal(predicted.owner.address, owner.address);
    assert.deepEqual(predicted.safe.owners, [owner.address]);
    assert.equal(predicted.safe.threshold, 1);
    assert.equal(predicted.safe.deployed, false);
  },
);

test(
  "fork: both deploy txs land and the Safe reads back passkey-owned",
  { skip: skipChain || !pk },
  async () => {
    const publicClient = createPublicClient({ transport: http(rpc!) });
    const chainId = await publicClient.getChainId();
    const chain = defineChain({
      id: chainId,
      name: "safe-passkey-fork",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc!] } },
    });
    const account = privateKeyToAccount(pk as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport: http(rpc!) });

    const { x, y } = realP256();
    const cose = encodeCoseKey([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]);

    // Salt keyed to the sender's nonce so a re-run against a live fork starts clean.
    const salt = `passkey-e2e-${await publicClient.getTransactionCount({ address: account.address })}`;
    const plan = await deployPasskeySafe(publicClient, {
      provider: rpc!,
      publicKey: cose,
      saltNonce: salt,
    });

    for (const tx of [plan.signerDeployTx, plan.safeDeployTx]) {
      const hash = await walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
    }

    // The signer now has code at exactly the predicted address…
    const code = await publicClient.getCode({ address: plan.owner.address });
    assert.ok(code && code !== "0x", "signer contract deployed at the predicted address");

    // …and the deployed Safe's live owner set is the signer, nothing else.
    const safe = await connectSafeWallet({
      provider: rpc!,
      safeAddress: plan.safeDeployTx.safeAddress,
    });
    assert.deepEqual(safe.owners, [plan.owner.address]);
    assert.equal(safe.threshold, 1);
    assert.equal(safe.deployed, true);
  },
);

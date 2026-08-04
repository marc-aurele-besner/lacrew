/**
 * Root-Safe deployment tests (F1.3).
 *
 * The plan arithmetic, the owner check and the relay allowlist run everywhere.
 * The end-to-end loop needs the canonical Safe singletons and passkey module,
 * so it runs on a local anvil forking a chain that has them — prefunded anvil
 * accounts are the sender, and nothing is published anywhere:
 *
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   SAFE_FORK_RPC=http://127.0.0.1:8546 \
 *   SAFE_FORK_PK=<an anvil dev key> pnpm --filter @lacrew/adapter-wallet-safe test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertRelayableChain,
  assertRelayAllowlist,
  deployRootSafe,
  relayRootSafeDeployment,
  rootSafeDeployTxs,
  rootSafeOwnersMatch,
  verifyRootSafeDeployed,
} from "./index.js";

const SIGNER_TX = {
  to: "0x1d31F259eE307358a26dFb23EB365939E8641195" as `0x${string}`,
  data: "0xdeadbeef" as `0x${string}`,
  value: 0n,
};
const SAFE_TX = {
  to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as `0x${string}`,
  data: "0xfeedface" as `0x${string}`,
  value: 0n,
};

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
function realCoseKey(): Uint8Array {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return encodeCoseKey([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
    [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
  ]);
}

test("a fresh root plans the signer before the Safe", () => {
  const txs = rootSafeDeployTxs({
    ownerDeployed: false,
    safeDeployed: false,
    signerDeployTx: SIGNER_TX,
    safeDeployTx: SAFE_TX,
  });
  assert.deepEqual(
    txs.map((t) => t.step),
    ["passkey-signer", "safe-proxy"],
  );
});

test("a half-finished deployment plans only what is missing", () => {
  // Re-sending a factory call for a contract that exists reverts, so a plan
  // rebuilt after a partial failure has to skip the half that landed.
  assert.deepEqual(
    rootSafeDeployTxs({
      ownerDeployed: true,
      safeDeployed: false,
      signerDeployTx: SIGNER_TX,
      safeDeployTx: SAFE_TX,
    }).map((t) => t.step),
    ["safe-proxy"],
  );
  // An existing Safe has no deployment transaction to offer at all — the
  // builder refuses to author one — so the signer is the whole plan.
  assert.deepEqual(
    rootSafeDeployTxs({
      ownerDeployed: false,
      safeDeployed: true,
      signerDeployTx: SIGNER_TX,
      safeDeployTx: null,
    }).map((t) => t.step),
    ["passkey-signer"],
  );
});

test("a fully deployed root plans nothing", () => {
  assert.deepEqual(
    rootSafeDeployTxs({
      ownerDeployed: true,
      safeDeployed: true,
      signerDeployTx: SIGNER_TX,
      safeDeployTx: null,
    }),
    [],
  );
});

test("only a 1-of-1 owned by the passkey signer matches", () => {
  const signer = "0xAbC0000000000000000000000000000000000001";
  assert.equal(rootSafeOwnersMatch([signer], signer), true);
  // Address case is display, not identity.
  assert.equal(rootSafeOwnersMatch([signer.toLowerCase()], signer.toUpperCase()), true);
  // The relayer paid for the deployment; it must not come back as an owner.
  assert.equal(rootSafeOwnersMatch(["0x00000000000000000000000000000000000000f0"], signer), false);
  assert.equal(
    rootSafeOwnersMatch([signer, "0x00000000000000000000000000000000000000f0"], signer),
    false,
  );
  assert.equal(rootSafeOwnersMatch([], signer), false);
});

test("relaying refuses without an explicit allowlist", () => {
  assert.throws(() => assertRelayAllowlist([]), /explicit chain allowlist/);
  assert.throws(() => assertRelayableChain(31337, []), /explicit chain allowlist/);
  assert.throws(
    () => assertRelayableChain(1, [31337]),
    /Chain 1 is not in the root-Safe relay allowlist/,
  );
  assert.doesNotThrow(() => assertRelayableChain(31337, [31337, 8453]));
});

test("an unconfigured relayer refuses before it reaches an RPC", async () => {
  // The RPC is deliberately unroutable: reaching it at all would be the bug.
  await assert.rejects(
    relayRootSafeDeployment({
      provider: "http://127.0.0.1:1",
      privateKey: `0x${"11".repeat(32)}`,
      allowChainIds: [],
      plan: {
        predicted: {
          chainId: 31337,
          safeAddress: SAFE_TX.to,
          ownerAddress: SIGNER_TX.to,
          safeDeployed: false,
          ownerDeployed: false,
        },
        txs: [{ step: "safe-proxy", ...SAFE_TX }],
      },
    }),
    /explicit chain allowlist/,
  );
});

const rpc = process.env.SAFE_FORK_RPC;
const pk = process.env.SAFE_FORK_PK;
const skipChain = !rpc || !pk;

test(
  "anvil: predict → relay → code at the predicted address, owned by the passkey",
  { skip: skipChain },
  async () => {
    const client = createPublicClient({ transport: http(rpc!) });
    const chainId = await client.getChainId();
    const sender = privateKeyToAccount(pk as `0x${string}`);
    // Salt keyed to the sender's nonce so a re-run against a live fork is clean.
    const salt = `root-deploy-${await client.getTransactionCount({ address: sender.address })}`;
    const publicKey = realCoseKey();

    const plan = await deployRootSafe(client, { provider: rpc!, publicKey, saltNonce: salt });
    assert.equal(plan.predicted.chainId, chainId);
    assert.equal(plan.predicted.safeDeployed, false);
    assert.equal(plan.predicted.ownerDeployed, false);
    assert.deepEqual(
      plan.txs.map((t) => t.step),
      ["passkey-signer", "safe-proxy"],
    );

    // Nothing is deployed yet, and the verification says so rather than
    // reporting an address that happens to be predictable.
    const before = await verifyRootSafeDeployed({
      provider: rpc!,
      safeAddress: plan.predicted.safeAddress,
      expectedOwner: plan.predicted.ownerAddress,
    });
    assert.equal(before.deployed, false);
    assert.equal(before.ownerMatches, false);

    const relayed = await relayRootSafeDeployment({
      provider: rpc!,
      privateKey: pk as `0x${string}`,
      allowChainIds: [chainId],
      plan,
    });
    assert.equal(relayed.hashes.length, 2);
    assert.equal(relayed.verification.deployed, true);
    assert.equal(relayed.verification.ownerMatches, true);
    assert.equal(relayed.verification.threshold, 1);
    // The sender paid the gas and owns none of the result.
    assert.deepEqual(relayed.verification.owners, [plan.predicted.ownerAddress]);
    assert.notEqual(relayed.verification.owners[0]!.toLowerCase(), relayed.sender.toLowerCase());

    const signerCode = await client.getCode({ address: plan.predicted.ownerAddress });
    assert.ok(signerCode && signerCode !== "0x", "signer code at the predicted address");
    const safeCode = await client.getCode({ address: plan.predicted.safeAddress });
    assert.ok(safeCode && safeCode !== "0x", "Safe code at the predicted address");

    // Re-planning the same root now has nothing left to do.
    const after = await deployRootSafe(client, { provider: rpc!, publicKey, saltNonce: salt });
    assert.equal(after.predicted.safeAddress, plan.predicted.safeAddress);
    assert.equal(after.predicted.safeDeployed, true);
    assert.equal(after.predicted.ownerDeployed, true);
    assert.deepEqual(after.txs, []);
  },
);

test(
  "anvil: a chain outside the allowlist is refused with nothing sent",
  { skip: skipChain },
  async () => {
    const client = createPublicClient({ transport: http(rpc!) });
    const chainId = await client.getChainId();
    const sender = privateKeyToAccount(pk as `0x${string}`);
    const nonceBefore = await client.getTransactionCount({ address: sender.address });
    const plan = await deployRootSafe(client, {
      provider: rpc!,
      publicKey: realCoseKey(),
      saltNonce: `root-deploy-refused-${nonceBefore}`,
    });

    await assert.rejects(
      relayRootSafeDeployment({
        provider: rpc!,
        privateKey: pk as `0x${string}`,
        allowChainIds: [chainId + 1],
        plan,
      }),
      /is not in the root-Safe relay allowlist/,
    );
    assert.equal(
      await client.getTransactionCount({ address: sender.address }),
      nonceBefore,
      "a refused relay sends no transaction",
    );
  },
);

/**
 * A passkey-owned Safe approving a real escalation, end to end (F2.6 / F1.3).
 *
 * This is the acceptance criterion as an executable claim: a Safe that a
 * WebAuthn credential owns is the intent's `awaitingApprover`, the *Safe* sends
 * `EscalationRouter.resolve`, and USDC lands on the target. Every contract here
 * is the real one — Safe's singletons and passkey module from the fork, the
 * repo's own `EscalationRouter`, `OrgRegistry`, `Treasury`, `SpendCapPolicy`
 * and `MockUSDC` from `contracts/out`. Nothing about the sender check is
 * simulated, which is the point: `resolve` reverts for any sender that is not
 * the awaiting approver, so a run that moves funds has proved the Safe was it.
 *
 * The org is bootstrapped *through* the Safe as well — `OrgRegistry.addNode` is
 * authorised to the root, and the root is the Safe — so the same
 * `execTransaction` path is exercised twice, for two different calls.
 *
 * Needs the canonical Safe deployments, so it runs on an anvil forking a chain
 * that has them, and needs `forge build` to have produced the artifacts:
 *
 *   forge build --root contracts
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   SAFE_FORK_RPC=http://127.0.0.1:8546 \
 *   SAFE_FORK_PK=<an anvil dev key> pnpm --filter @lacrew/adapter-wallet-safe test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { p256 } from "@noble/curves/nist";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildSafeResolveExecution,
  buildSafeResolvePlan,
  buildSafeTransactionPlan,
  deployRootSafe,
  relayRootSafeDeployment,
  relaySafeExecution,
  verifySafeApprover,
} from "./index.js";

const rpc = process.env.SAFE_FORK_RPC;
const pk = process.env.SAFE_FORK_PK as `0x${string}` | undefined;
const CONTRACTS_OUT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../contracts/out",
);
const haveArtifacts = existsSync(resolvePath(CONTRACTS_OUT, "EscalationRouter.sol"));
const skip = !rpc || !pk || !haveArtifacts;

const USDC = 10n ** 6n;
const WORKER_CAP = 50n * USDC;
const SPEND = 75n * USDC;
const WORKER = "0x00000000000000000000000000000000000000b9" as const;
const TARGET = "0x00000000000000000000000000000000000000cc" as const;
/** WebAuthn ceremony context. Nothing checks these onchain; the Safe verifies
 *  the reconstructed client data, and these are the bytes it reconstructs. */
const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";

type Artifact = { abi: Abi; bytecode: { object: `0x${string}` } };

function artifact(name: string): Artifact {
  return JSON.parse(
    readFileSync(resolvePath(CONTRACTS_OUT, `${name}.sol`, `${name}.json`), "utf8"),
  ) as Artifact;
}

/** A WebAuthn credential this test can both register and sign with. */
function credential() {
  const privateKey = p256.utils.randomPrivateKey();
  const point = p256.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(false);
  const x = point.slice(1, 33);
  const y = point.slice(33, 65);
  return {
    privateKey,
    // The COSE_Key blob a registration attestation carries.
    publicKey: Buffer.from([
      0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y,
    ]).toString("base64url"),
  };
}

/**
 * A `navigator.credentials.get()` assertion over one hash.
 *
 * `0x05` is user-present **and** user-verified: Safe's WebAuthn signer requires
 * the second, so an assertion without it verifies off-chain and reverts here.
 * The client data is serialized in WebAuthn's own field order, which is what
 * lets the Safe rebuild these exact bytes from the challenge alone.
 */
function assertOver(cred: ReturnType<typeof credential>, hash: `0x${string}`) {
  const challenge = Buffer.from(hash.slice(2), "hex").toString("base64url");
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
  );
  const authData = new Uint8Array(37);
  authData.set(new Uint8Array(createHash("sha256").update(RP_ID).digest()), 0);
  authData[32] = 0x05;
  const digest = createHash("sha256")
    .update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]))
    .digest();
  return {
    authenticatorData: Buffer.from(authData).toString("base64url"),
    clientDataJSON: clientData.toString("base64url"),
    signature: Buffer.from(
      p256.sign(new Uint8Array(digest), cred.privateKey).toDERRawBytes(),
    ).toString("base64url"),
  };
}

const ORG_ABI = parseAbi([
  "function addNode(address account, uint8 kind, address parent)",
  "function getNode(address account) view returns ((address account, uint8 kind, address parent, bool active))",
]);
const ROUTER_ABI = parseAbi([
  "function setTreasury(address treasury_)",
  "function propose(address agent, address target, uint256 value, bytes data) returns (uint256 intentId, uint8 verdict)",
  "function intents(uint256) view returns (address agent, address target, uint256 value, bytes data, address awaitingApprover, bool resolved, bool approved)",
]);
const TREASURY_ABI = parseAbi([
  "function deposit(uint256 amount)",
  "function streamAllowance(address node, uint256 amount, uint64 epoch)",
]);
const POLICY_ABI = parseAbi(["function setAgentCap(address agent, uint256 cap_)"]);
const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

test(
  "anvil: a passkey Safe is the awaiting approver, and its own resolve moves the money",
  { skip },
  async () => {
    const publicClient = createPublicClient({ transport: http(rpc!) });
    const chainId = await publicClient.getChainId();
    const account = privateKeyToAccount(pk!);
    const chain = defineChain({
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc!] } },
    });
    const wallet = createWalletClient({ account, chain, transport: http(rpc!) });

    /** Deploy one artifact and wait for its address. */
    const deploy = async (name: string, args: unknown[]): Promise<`0x${string}`> => {
      const { abi, bytecode } = artifact(name);
      const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success", `${name} deployment reverted`);
      return receipt.contractAddress!;
    };
    const send = async (to: `0x${string}`, data: `0x${string}`): Promise<void> => {
      const hash = await wallet.sendTransaction({ to, data, value: 0n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success", `call to ${to} reverted`);
    };

    // ——— the root: a Safe nobody holds a key for ———
    const cred = credential();
    const salt = `safe-root-approve-${await publicClient.getTransactionCount({
      address: account.address,
    })}`;
    const plan = await deployRootSafe(publicClient, {
      provider: rpc!,
      publicKey: cred.publicKey,
      saltNonce: salt,
    });
    const relayed = await relayRootSafeDeployment({
      provider: rpc!,
      privateKey: pk!,
      allowChainIds: [chainId],
      plan,
    });
    assert.equal(relayed.verification.ownerMatches, true, "the Safe must be the credential's");
    const safe = plan.predicted.safeAddress;
    const owner = plan.predicted.ownerAddress;
    // The gas payer owns none of it — the check that makes "root" mean anything.
    assert.notEqual(relayed.sender.toLowerCase(), owner.toLowerCase());

    // ——— the org, rooted at that Safe ———
    const usdc = await deploy("MockUSDC", []);
    const org = await deploy("OrgRegistry", [safe]);
    const policy = await deploy("SpendCapPolicy", [1_000_000n * USDC]);
    const router = await deploy("EscalationRouter", [org, policy]);
    const treasury = await deploy("Treasury", [org, usdc, router]);
    await send(
      router,
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "setTreasury", args: [treasury] }),
    );
    // The worker's own cap is what makes a 75 USDC spend escalate at all.
    await send(
      policy,
      encodeFunctionData({ abi: POLICY_ABI, functionName: "setAgentCap", args: [WORKER, WORKER_CAP] }),
    );

    /** Sign and send one Safe transaction with the credential. */
    const asTheSafe = async (to: `0x${string}`, data: `0x${string}`): Promise<`0x${string}`> => {
      const built = await buildSafeTransactionPlan(publicClient, { safeAddress: safe, to, data });
      const execution = buildSafeResolveExecution(built, owner, assertOver(cred, built.safeTxHash));
      const { hash } = await relaySafeExecution({
        provider: rpc!,
        privateKey: pk!,
        allowChainIds: [chainId],
        execution,
      });
      return hash;
    };

    // `addNode` is authorised to the registry's root, and the root is the Safe.
    // So the org cannot be bootstrapped except through the passkey — the same
    // path the approval below takes, for a different call.
    await asTheSafe(
      org,
      encodeFunctionData({ abi: ORG_ABI, functionName: "addNode", args: [WORKER, 2, safe] }),
    );
    const node = (await publicClient.readContract({
      address: org,
      abi: ORG_ABI,
      functionName: "getNode",
      args: [WORKER],
    })) as { parent: `0x${string}`; active: boolean };
    assert.equal(node.active, true);
    assert.equal(node.parent.toLowerCase(), safe.toLowerCase());

    // ——— fund the worker's budget ———
    await send(
      usdc,
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "mint",
        args: [account.address, 1000n * USDC],
      }),
    );
    await send(
      usdc,
      encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [treasury, 1000n * USDC] }),
    );
    await send(
      treasury,
      encodeFunctionData({ abi: TREASURY_ABI, functionName: "deposit", args: [1000n * USDC] }),
    );
    await send(
      treasury,
      encodeFunctionData({
        abi: TREASURY_ABI,
        functionName: "streamAllowance",
        args: [WORKER, 200n * USDC, 0n],
      }),
    );

    // ——— the worker proposes over its cap, and the Safe is who it climbs to ———
    await send(
      router,
      encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "propose",
        args: [WORKER, TARGET, SPEND, "0x"],
      }),
    );
    const pending = (await publicClient.readContract({
      address: router,
      abi: ROUTER_ABI,
      functionName: "intents",
      args: [1n],
    })) as readonly [
      `0x${string}`,
      `0x${string}`,
      bigint,
      `0x${string}`,
      `0x${string}`,
      boolean,
      boolean,
    ];
    // The acceptance criterion, first half.
    assert.equal(pending[4].toLowerCase(), safe.toLowerCase(), "the Safe must be awaitingApprover");
    assert.equal(pending[5], false);
    assert.equal(await balanceOf(publicClient, usdc, TARGET), 0n);

    // ——— a wrong credential's assertion cannot spend it ———
    const decoy = credential();
    const decoyPlan = await buildSafeResolvePlan(publicClient, {
      safeAddress: safe,
      escalationRouter: router,
      intentId: 1n,
      approved: true,
    });
    await assert.rejects(
      relaySafeExecution({
        provider: rpc!,
        privateKey: pk!,
        allowChainIds: [chainId],
        execution: buildSafeResolveExecution(
          decoyPlan,
          owner,
          assertOver(decoy, decoyPlan.safeTxHash),
        ),
      }),
      /reverted|safe_exec_reverted/,
      "an assertion from another authenticator must not execute as the Safe",
    );
    assert.equal(
      await balanceOf(publicClient, usdc, TARGET),
      0n,
      "a refused approval leaves the funds where they were",
    );

    // ——— the root's own assertion settles it, and the Safe is msg.sender ———
    const approval = await buildSafeResolvePlan(publicClient, {
      safeAddress: safe,
      escalationRouter: router,
      intentId: 1n,
      approved: true,
    });
    const txHash = await (async () => {
      const { hash } = await relaySafeExecution({
        provider: rpc!,
        privateKey: pk!,
        allowChainIds: [chainId],
        execution: buildSafeResolveExecution(
          approval,
          owner,
          assertOver(cred, approval.safeTxHash),
        ),
      });
      return hash;
    })();

    // The acceptance criterion, second half: the money moved, and the
    // transaction the router saw came from the Safe.
    assert.equal(await balanceOf(publicClient, usdc, TARGET), SPEND);
    const settled = (await publicClient.readContract({
      address: router,
      abi: ROUTER_ABI,
      functionName: "intents",
      args: [1n],
    })) as readonly [
      `0x${string}`,
      `0x${string}`,
      bigint,
      `0x${string}`,
      `0x${string}`,
      boolean,
      boolean,
    ];
    assert.equal(settled[5], true, "resolved");
    assert.equal(settled[6], true, "approved");

    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    // The relayer's EOA sent the outer transaction and authorised nothing; the
    // call the router judged came from the Safe.
    assert.equal(receipt.from.toLowerCase(), account.address.toLowerCase());
    assert.equal(receipt.to?.toLowerCase(), safe.toLowerCase());

    // And the Safe is still, verifiably, the credential's — deployment confers
    // no ownership, so this is the check the whole path rests on.
    const verification = await verifySafeApprover({
      provider: rpc!,
      safeAddress: safe,
      expectedOwner: owner,
    });
    assert.equal(verification.ownerMatches, true);
  },
);

async function balanceOf(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  who: `0x${string}`,
): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

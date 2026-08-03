/**
 * Deploying a passkey-owned root Safe (PRD F1.3).
 *
 * `passkey.ts` answers what the root *will* be: a credential implies a signer
 * contract, and the signer implies a 1-of-1 Safe, both counterfactual. This
 * module is the step that makes the prediction real — the plan of transactions
 * that puts code at those two addresses, the read that confirms it landed
 * passkey-owned, and one broadcast path for chains a caller has explicitly
 * said a key may spend on.
 *
 * Who broadcasts is the caller's decision, and the two modes are deliberately
 * separate calls rather than a flag:
 *
 * - `deployRootSafe` returns transactions and sends nothing. This is the
 *   default: the user's own wallet is the sender, so no key beyond the user's
 *   is involved in establishing their root.
 * - `relayRootSafeDeployment` broadcasts with a caller-supplied key, and only
 *   for chain ids the caller passes in. There is no default allowlist: a
 *   relayer configured for a local chain must never quietly become a mainnet
 *   sender because a chain id changed.
 *
 * Deploying does not confer ownership — the Safe's owner is the signer the
 * credential implies, whoever paid the gas. `verifyRootSafeDeployed` is what
 * proves that, and nothing here should be trusted without it.
 */

import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildPasskeyOwnerDeployTx,
  predictPasskeySafe,
  type PasskeySafeOptions,
} from "./passkey.js";
import { deploySafeWallet } from "./safe.js";

/** Which half of the deployment a transaction is; both are plain factory calls. */
export type RootSafeDeployStep = "passkey-signer" | "safe-proxy";

export type RootSafeDeployTx = {
  step: RootSafeDeployStep;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

export type RootSafePrediction = {
  chainId: number;
  safeAddress: `0x${string}`;
  /** The SafeWebAuthnSigner the credential owns the Safe through. */
  ownerAddress: `0x${string}`;
  safeDeployed: boolean;
  ownerDeployed: boolean;
};

export type RootSafeDeployPlan = {
  predicted: RootSafePrediction;
  /**
   * The transactions still outstanding, in order. Empty means the root Safe
   * and its signer already have code — deployment is not a thing to redo, and
   * re-sending a factory call for an existing proxy reverts.
   */
  txs: RootSafeDeployTx[];
};

/**
 * The outstanding half of a deployment. Each contract is skipped once it has
 * code, so a plan is safe to rebuild and re-send after a partial failure —
 * a signer that landed and a Safe that did not is an ordinary state.
 */
export function rootSafeDeployTxs(input: {
  ownerDeployed: boolean;
  safeDeployed: boolean;
  signerDeployTx: { to: `0x${string}`; data: `0x${string}`; value: bigint };
  safeDeployTx: { to: `0x${string}`; data: `0x${string}`; value: bigint } | null;
}): RootSafeDeployTx[] {
  const txs: RootSafeDeployTx[] = [];
  // Signer first: the Safe can be deployed without it (an owner is just an
  // address), but a Safe whose owner has no code cannot verify a signature,
  // and a root that cannot sign is not a root anyone should be handed.
  if (!input.ownerDeployed) txs.push({ step: "passkey-signer", ...input.signerDeployTx });
  if (!input.safeDeployed && input.safeDeployTx) {
    txs.push({ step: "safe-proxy", ...input.safeDeployTx });
  }
  return txs;
}

/** The viem client surface the prediction reads through. */
type ChainReader = Parameters<typeof predictPasskeySafe>[0];

/**
 * Everything needed to deploy a tenant's root Safe: the predicted addresses
 * and the transactions that realise them. Builds only — the returned
 * transactions are for a sender the caller chooses.
 *
 * The chain is read before anything is built. A Safe that already exists has
 * no deployment transaction to offer — protocol-kit refuses to author one, and
 * rightly: re-sending it would revert. That case is an empty plan against a
 * `safeDeployed: true` prediction, not an error, because "deploy this root" and
 * "this root is already deployed" is a question with an answer.
 */
export async function deployRootSafe(
  client: ChainReader,
  opts: PasskeySafeOptions,
): Promise<RootSafeDeployPlan> {
  const chainId = await client.getChainId();
  const { safe, owner } = await predictPasskeySafe(client, opts);
  const safeDeployTx = safe.deployed
    ? null
    : await deploySafeWallet({
        provider: opts.provider,
        owners: [owner.address],
        threshold: 1,
        ...(opts.saltNonce ? { saltNonce: opts.saltNonce } : {}),
      });
  return {
    predicted: {
      chainId,
      safeAddress: safe.address,
      ownerAddress: owner.address,
      safeDeployed: safe.deployed,
      ownerDeployed: owner.deployed,
    },
    txs: rootSafeDeployTxs({
      ownerDeployed: owner.deployed,
      safeDeployed: safe.deployed,
      signerDeployTx: buildPasskeyOwnerDeployTx(chainId, owner.coordinates, {
        ...(opts.precompile !== undefined ? { precompile: opts.precompile } : {}),
      }),
      safeDeployTx,
    }),
  };
}

const SAFE_READ_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);

export type RootSafeVerification = {
  /** True only when there is code at the address. */
  deployed: boolean;
  owners: `0x${string}`[];
  threshold: number | null;
  /** True when the live owner set is exactly the passkey signer, 1-of-1. */
  ownerMatches: boolean;
  /** Present when the Safe is not verifiably the predicted, passkey-owned one. */
  reason?: string;
};

/** Exactly one owner, and it is the expected signer. Addresses compare case-insensitively. */
export function rootSafeOwnersMatch(
  owners: readonly string[],
  expectedOwner: string,
): boolean {
  return (
    owners.length === 1 && owners[0]!.toLowerCase() === expectedOwner.toLowerCase()
  );
}

/**
 * Read the chain and answer whether the root Safe is really deployed and
 * really owned by the passkey. A relayer paid for this deployment; the check
 * that it did not end up owning the result is the whole point, so a mismatch
 * is reported as a failure rather than folded into "deployed".
 */
export async function verifyRootSafeDeployed(opts: {
  provider: string;
  safeAddress: `0x${string}`;
  expectedOwner: `0x${string}`;
}): Promise<RootSafeVerification> {
  const client = createPublicClient({ transport: http(opts.provider) });
  const code = await client.getCode({ address: opts.safeAddress });
  if (!code || code === "0x") {
    return {
      deployed: false,
      owners: [],
      threshold: null,
      ownerMatches: false,
      reason: `No code at ${opts.safeAddress} — the Safe is still counterfactual.`,
    };
  }
  let owners: `0x${string}`[];
  let threshold: number;
  try {
    const [read, thr] = await Promise.all([
      client.readContract({ address: opts.safeAddress, abi: SAFE_READ_ABI, functionName: "getOwners" }),
      client.readContract({ address: opts.safeAddress, abi: SAFE_READ_ABI, functionName: "getThreshold" }),
    ]);
    owners = [...read] as `0x${string}`[];
    threshold = Number(thr);
  } catch (err) {
    // Code that does not answer a Safe's own reads is not a Safe.
    return {
      deployed: true,
      owners: [],
      threshold: null,
      ownerMatches: false,
      reason: `Contract at ${opts.safeAddress} did not answer getOwners()/getThreshold(): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const ownerMatches = rootSafeOwnersMatch(owners, opts.expectedOwner) && threshold === 1;
  return {
    deployed: true,
    owners,
    threshold,
    ownerMatches,
    ...(ownerMatches
      ? {}
      : {
          reason: `Deployed Safe is ${threshold}-of-${owners.length} owned by ${owners.join(", ")}, not 1-of-1 by the passkey signer ${opts.expectedOwner}.`,
        }),
  };
}

/**
 * Refuse to relay anywhere the caller did not name. There is no default and no
 * "unless it looks like mainnet" heuristic: an allowlist that has to be passed
 * in is the only version an operator cannot end up with by accident.
 */
export function assertRelayAllowlist(allowChainIds: readonly number[]): void {
  if (allowChainIds.length === 0) {
    throw new Error(
      "Root-Safe relaying needs an explicit chain allowlist — no chain is relayable by default.",
    );
  }
}

export function assertRelayableChain(
  chainId: number,
  allowChainIds: readonly number[],
): void {
  assertRelayAllowlist(allowChainIds);
  if (!allowChainIds.includes(chainId)) {
    throw new Error(
      `Chain ${chainId} is not in the root-Safe relay allowlist (${allowChainIds.join(", ")}).`,
    );
  }
}

export type RelayRootSafeOptions = {
  /** RPC the sender broadcasts through. */
  provider: string;
  /** Sender key. Pays gas and owns nothing the deployment produces. */
  privateKey: `0x${string}`;
  /** Chain ids this key may broadcast on; an empty list refuses everything. */
  allowChainIds: readonly number[];
  plan: RootSafeDeployPlan;
};

export type RelayRootSafeResult = {
  sender: `0x${string}`;
  /** One hash per transaction actually sent, in plan order. */
  hashes: { step: RootSafeDeployStep; hash: `0x${string}` }[];
  verification: RootSafeVerification;
};

/**
 * Broadcast a plan with a caller-supplied key and confirm what landed.
 *
 * Sequential rather than batched: the two transactions go to different
 * factories, and a failure has to name which half of the root is missing.
 * A reverted receipt throws — a deployment that did not happen must never
 * return a result a caller could read as success.
 */
export async function relayRootSafeDeployment(
  opts: RelayRootSafeOptions,
): Promise<RelayRootSafeResult> {
  // Before any RPC: an unconfigured relayer must refuse without first telling
  // an endpoint which chain it was hoping to spend on.
  assertRelayAllowlist(opts.allowChainIds);
  const publicClient = createPublicClient({ transport: http(opts.provider) });
  const chainId = await publicClient.getChainId();
  assertRelayableChain(chainId, opts.allowChainIds);
  if (chainId !== opts.plan.predicted.chainId) {
    throw new Error(
      `Plan was built for chain ${opts.plan.predicted.chainId} but this RPC is chain ${chainId}.`,
    );
  }

  const account = privateKeyToAccount(opts.privateKey);
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.provider] } },
  });
  const walletClient = createWalletClient({ account, chain, transport: http(opts.provider) });

  const hashes: { step: RootSafeDeployStep; hash: `0x${string}` }[] = [];
  for (const tx of opts.plan.txs) {
    const hash = await walletClient.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Root-Safe ${tx.step} deployment reverted (${hash}).`);
    }
    hashes.push({ step: tx.step, hash });
  }

  return {
    sender: account.address,
    hashes,
    verification: await verifyRootSafeDeployed({
      provider: opts.provider,
      safeAddress: opts.plan.predicted.safeAddress,
      expectedOwner: opts.plan.predicted.ownerAddress,
    }),
  };
}

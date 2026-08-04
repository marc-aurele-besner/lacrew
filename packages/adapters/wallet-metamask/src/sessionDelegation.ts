/**
 * DelegationProvider implementation (F1.3): wires the Delegation Toolkit
 * primitives into the orchestrator's session-issuance seam.
 *
 * Issue: agent → deterministic seat smart account (root-owned, salted by the
 * agent address) → budget-caveated delegation to the session key, expiring
 * with the session's own timestamp.
 *
 * Revoke: the seat only acts through the EntryPoint, and `handleOps` is
 * permissionless — so revocation is ONE plain transaction the root wallet
 * self-bundles (a single signed UserOp), no bundler service anywhere.
 * Fork-verified: a direct owner→DelegationManager disable reverts, the
 * self-bundled op lands, and redemption afterwards reverts.
 */

import {
  concatHex,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  pad,
  toHex,
  type PublicClient,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import type { BuiltTx, DelegationProvider, SessionDelegation } from "@lacrew/core";
import {
  buildAccountDeploymentTx,
  getDelegationManagerAddress,
  getEnvironment,
  getMetaMaskSmartAccount,
  SUPPORTED_CHAIN_IDS,
  type MetaMaskSmartAccount,
  type OwnerSigner,
} from "./account.js";
import {
  buildAgentDelegation,
  buildDisableDelegationTx,
  signAgentDelegation,
  type Budget,
  type Delegation,
} from "./delegation.js";

export type MetaMaskDelegationProviderOptions = {
  /** RPC the provider reads and predicts through. */
  rpcUrl: string;
  chainId: number;
  /** Signs delegations and revocation user-ops. The seat's owner (root today). */
  owner: OwnerSigner;
  /**
   * Budget denomination: an ERC-20 (the org's primary asset) or native when
   * omitted. `maxValue` at issue time is raw units of this token.
   */
  token?: `0x${string}`;
};

/** The kit demands a chain-bearing client; build one from the RPC url. */
function chainClient(rpcUrl: string, chainId: number): PublicClient {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

const ENTRY_POINT_GAS = {
  callGasLimit: 500_000n,
  verificationGasLimit: 500_000n,
  preVerificationGas: 100_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

async function entryPointAddress(chainId: number): Promise<`0x${string}`> {
  const env = (await getEnvironment(chainId)) as { EntryPoint?: `0x${string}` };
  if (!env.EntryPoint) {
    throw new Error(`No EntryPoint address for chain ${chainId}.`);
  }
  return env.EntryPoint;
}

/** Pack a v0.7 user op the way `EntryPoint.handleOps` expects it. */
function packUserOp(op: {
  sender: `0x${string}`;
  nonce: bigint;
  callData: `0x${string}`;
  signature: `0x${string}`;
}) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: "0x" as const,
    callData: op.callData,
    accountGasLimits: concatHex([
      pad(toHex(ENTRY_POINT_GAS.verificationGasLimit), { size: 16 }),
      pad(toHex(ENTRY_POINT_GAS.callGasLimit), { size: 16 }),
    ]),
    preVerificationGas: ENTRY_POINT_GAS.preVerificationGas,
    gasFees: concatHex([
      pad(toHex(ENTRY_POINT_GAS.maxPriorityFeePerGas), { size: 16 }),
      pad(toHex(ENTRY_POINT_GAS.maxFeePerGas), { size: 16 }),
    ]),
    paymasterAndData: "0x" as const,
    signature: op.signature,
  };
}

export function createMetaMaskDelegationProvider(
  opts: MetaMaskDelegationProviderOptions,
): DelegationProvider {
  if (!(SUPPORTED_CHAIN_IDS as readonly number[]).includes(opts.chainId)) {
    throw new Error(
      `MetaMask delegations are unsupported on chain ${opts.chainId} (supported: ${SUPPORTED_CHAIN_IDS.join(", ")}).`,
    );
  }
  const client = chainClient(opts.rpcUrl, opts.chainId);

  const seatFor = (salt: string): Promise<MetaMaskSmartAccount> =>
    getMetaMaskSmartAccount({ client, owner: opts.owner, salt });

  return {
    provider: "metamask",

    async issue(args) {
      if (args.maxValue <= 0n) {
        throw new Error("A delegation budget must be positive.");
      }
      const seat = await seatFor(args.agent);
      const budget: Budget = opts.token
        ? { kind: "erc20Total", token: opts.token, maxAmount: args.maxValue }
        : { kind: "nativeTotal", maxAmount: args.maxValue };
      const unsigned = await buildAgentDelegation({
        chainId: opts.chainId,
        from: seat.address,
        delegate: args.sessionKey,
        budget,
        expiresAt: args.expiresAtSec,
      });
      const signed = await signAgentDelegation(seat, unsigned);
      const deployed = await seat.isDeployed();
      const seatDeployTx = deployed
        ? null
        : await buildAccountDeploymentTx({ client, owner: opts.owner, salt: args.agent });
      const delegation: SessionDelegation = {
        provider: "metamask",
        seat: seat.address,
        seatDeployed: deployed,
        delegate: args.sessionKey,
        delegationManager: await getDelegationManagerAddress(opts.chainId),
        chainId: opts.chainId,
        budget: {
          kind: budget.kind as "erc20Total" | "nativeTotal",
          ...(opts.token ? { token: opts.token } : {}),
          amount: args.maxValue.toString(),
        },
        expiresAtSec: args.expiresAtSec,
        salt: args.agent,
        signed: signed as Record<string, unknown>,
      };
      return {
        delegation,
        ...(seatDeployTx
          ? {
              seatDeployTx: {
                to: seatDeployTx.to,
                data: seatDeployTx.data,
                value: seatDeployTx.value,
              },
            }
          : {}),
      };
    },

    async buildRevokeTx(delegation, beneficiary) {
      if (delegation.provider !== "metamask") {
        throw new Error(`Cannot revoke a "${delegation.provider}" delegation here.`);
      }
      const seat = await seatFor(delegation.salt);
      if (seat.address !== delegation.seat) {
        // A drifted seat means this owner/salt no longer derives the
        // delegator — signing a user op for the wrong account would burn gas
        // and revoke nothing.
        throw new Error(
          `Seat mismatch: derived ${seat.address}, delegation names ${delegation.seat}.`,
        );
      }
      const disable = await buildDisableDelegationTx(
        delegation.chainId,
        delegation.signed as Delegation,
      );
      const entryPoint = await entryPointAddress(delegation.chainId);
      const callData = await (
        seat as unknown as {
          encodeCalls: (
            calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: bigint }>,
          ) => Promise<`0x${string}`>;
        }
      ).encodeCalls([{ to: disable.to, data: disable.data, value: 0n }]);
      const nonce = (await client.readContract({
        address: entryPoint,
        abi: entryPoint07Abi,
        functionName: "getNonce",
        args: [delegation.seat, 0n],
      })) as bigint;
      const signature = await (
        seat as unknown as {
          signUserOperation: (op: Record<string, unknown>) => Promise<`0x${string}`>;
        }
      ).signUserOperation({
        sender: delegation.seat,
        nonce,
        callData,
        ...ENTRY_POINT_GAS,
        signature: "0x",
      });
      const data = encodeFunctionData({
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[packUserOp({ sender: delegation.seat, nonce, callData, signature })], beneficiary],
      });
      return { to: entryPoint, data, value: 0n };
    },
  };
}

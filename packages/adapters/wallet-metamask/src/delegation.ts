/**
 * Scoped delegations as agent session keys (PRD F1.8 / F3.3).
 *
 * A delegation is the MetaMask analogue of the Safe AllowanceModule allowance:
 * the seat wallet grants a delegate the right to spend, bounded by *caveats*
 * enforced onchain. The delegate is the agent's session key — scoped, expiring,
 * and revocable without moving funds.
 *
 * Redemption is a plain transaction sent by the delegate to the
 * DelegationManager. No ERC-4337 bundler is involved, which is what makes this
 * usable by an autonomous agent and verifiable on a fork.
 */

import { encodeFunctionData, parseAbi } from "viem";
import {
  getDelegationManagerAddress,
  getEnvironment,
  type MetaMaskSmartAccount,
  type MetaTransaction,
} from "./account.js";

async function loadKit() {
  try {
    return await import("@metamask/smart-accounts-kit");
  } catch {
    throw new Error(
      "@metamask/smart-accounts-kit is not installed — pnpm add @metamask/smart-accounts-kit to use MetaMask wallets.",
    );
  }
}

async function loadContracts() {
  return import("@metamask/smart-accounts-kit/contracts");
}

/** A signed delegation, opaque here — the kit owns its encoding. */
export type Delegation = Record<string, unknown> & { signature?: `0x${string}` };

/**
 * The budget a seat grants a session key.
 *
 * `*Total` caps lifetime spend; `*Period` refills every period, which is the
 * shape a recurring stipend takes.
 */
export type Budget =
  | { kind: "nativeTotal"; maxAmount: bigint }
  | { kind: "erc20Total"; token: `0x${string}`; maxAmount: bigint }
  | {
      kind: "nativePeriod";
      periodAmount: bigint;
      periodDurationSeconds: number;
      startDate?: number;
    }
  | {
      kind: "erc20Period";
      token: `0x${string}`;
      periodAmount: bigint;
      periodDurationSeconds: number;
      startDate?: number;
    };

/** Translate a budget into the kit's scope config. */
function toScope(budget: Budget, kit: Awaited<ReturnType<typeof loadKit>>) {
  const { ScopeType } = kit;
  switch (budget.kind) {
    case "nativeTotal":
      return { type: ScopeType.NativeTokenTransferAmount, maxAmount: budget.maxAmount };
    case "erc20Total":
      return {
        type: ScopeType.Erc20TransferAmount,
        tokenAddress: budget.token,
        maxAmount: budget.maxAmount,
      };
    case "nativePeriod":
      return {
        type: ScopeType.NativeTokenPeriodTransfer,
        periodAmount: budget.periodAmount,
        periodDuration: budget.periodDurationSeconds,
        startDate: budget.startDate ?? Math.floor(Date.now() / 1000),
      };
    case "erc20Period":
      return {
        type: ScopeType.Erc20PeriodTransfer,
        tokenAddress: budget.token,
        periodAmount: budget.periodAmount,
        periodDuration: budget.periodDurationSeconds,
        startDate: budget.startDate ?? Math.floor(Date.now() / 1000),
      };
  }
}

export type BuildDelegationOptions = {
  chainId: number;
  /** Seat wallet granting the budget. */
  from: `0x${string}`;
  /** Session key receiving it. */
  delegate: `0x${string}`;
  budget: Budget;
  /** Unix seconds after which the delegation stops working. */
  expiresAt?: number;
};

/**
 * Build an unsigned delegation for a seat's session key.
 *
 * An expiry is worth setting even when a cap exists: the cap bounds how much a
 * leaked key can take, while the expiry bounds for how long.
 */
export async function buildAgentDelegation(
  opts: BuildDelegationOptions,
): Promise<Delegation> {
  if (opts.expiresAt !== undefined && opts.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error("Delegation expiry is already in the past.");
  }
  const kit = await loadKit();
  const environment = await getEnvironment(opts.chainId);

  const caveats: unknown[] = [];
  if (opts.expiresAt !== undefined) {
    const { createCaveatBuilder } = await import("@metamask/smart-accounts-kit/utils");
    caveats.push(
      ...(createCaveatBuilder(environment as never)
        .addCaveat("timestamp", {
          afterThreshold: 0,
          beforeThreshold: opts.expiresAt,
        } as never)
        .build() as unknown[]),
    );
  }

  return kit.createDelegation({
    environment: environment as never,
    from: opts.from,
    to: opts.delegate,
    scope: toScope(opts.budget, kit) as never,
    ...(caveats.length > 0 ? { caveats: caveats as never } : {}),
  }) as unknown as Delegation;
}

/** Sign a delegation as the seat wallet. Only its owner key can do this. */
export async function signAgentDelegation(
  account: MetaMaskSmartAccount,
  delegation: Delegation,
): Promise<Delegation> {
  const signature = await account.signDelegation({ delegation });
  return { ...delegation, signature };
}

/** What the session key wants to do with the budget. */
export type Execution = {
  target: `0x${string}`;
  value: bigint;
  callData: `0x${string}`;
};

const ERC20_ABI = parseAbi(["function transfer(address,uint256) returns (bool)"]);

/** Execution moving ERC-20 out of the seat wallet. */
export function erc20TransferExecution(
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Execution {
  return {
    target: token,
    value: 0n,
    callData: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to, amount],
    }),
  };
}

/** Execution moving native value out of the seat wallet. */
export function nativeTransferExecution(to: `0x${string}`, amount: bigint): Execution {
  return { target: to, value: amount, callData: "0x" };
}

/**
 * Redemption transaction, sent **by the delegate**. The DelegationManager
 * checks `msg.sender` against the delegation, so a session key just signs an
 * ordinary transaction — no EIP-712 step and no bundler.
 *
 * Returned rather than broadcast, keeping this package free of key material.
 */
export async function buildRedeemTx(
  chainId: number,
  signedDelegation: Delegation,
  execution: Execution,
): Promise<MetaTransaction> {
  if (!signedDelegation.signature) {
    throw new Error("Delegation is unsigned — call signAgentDelegation() first.");
  }
  const kit = await loadKit();
  const { DelegationManager } = await loadContracts();
  const data = DelegationManager.encode.redeemDelegations({
    delegations: [[signedDelegation]],
    modes: [kit.ExecutionMode.SingleDefault],
    executions: [[execution]],
  } as never) as `0x${string}`;

  return { to: await getDelegationManagerAddress(chainId), data, value: 0n };
}

/**
 * Remaining spend in the current period, read from the enforcer. Period budgets
 * refill, so what is left must be read rather than inferred from past spend.
 * Only defined for the `*Period` budget kinds.
 */
export async function readRemainingBudget(opts: {
  client: unknown;
  chainId: number;
  delegation: Delegation;
  budget: Budget;
}): Promise<bigint> {
  const actions = await import("@metamask/smart-accounts-kit/actions");
  const environment = await getEnvironment(opts.chainId);
  const client = opts.client as never;
  const env = environment as never;
  const params = { delegation: opts.delegation } as never;

  if (opts.budget.kind === "erc20Period") {
    const r = await actions.getErc20PeriodTransferEnforcerAvailableAmount(
      client,
      env,
      params,
    );
    return r.availableAmount;
  }
  if (opts.budget.kind === "nativePeriod") {
    const r = await actions.getNativeTokenPeriodTransferEnforcerAvailableAmount(
      client,
      env,
      params,
    );
    return r.availableAmount;
  }
  throw new Error(
    `readRemainingBudget() only applies to period budgets, not ${opts.budget.kind}.`,
  );
}

/**
 * Revoke a session key. Disabling is an onchain action by the seat wallet, so
 * it is returned as an execution for the owner to run through the account.
 */
export async function buildDisableDelegationTx(
  chainId: number,
  signedDelegation: Delegation,
): Promise<MetaTransaction> {
  const { DelegationManager } = await loadContracts();
  const data = DelegationManager.encode.disableDelegation({
    delegation: signedDelegation,
  } as never) as `0x${string}`;
  return { to: await getDelegationManagerAddress(chainId), data, value: 0n };
}

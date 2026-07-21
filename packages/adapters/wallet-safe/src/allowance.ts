/**
 * Safe AllowanceModule wiring (PRD F1.8) — the onchain budget for an agent seat.
 *
 * The module maps cleanly onto the LaCrew model: a Safe holds the funds, a
 * *delegate* is granted a capped, optionally auto-refilling allowance on one
 * token, and the delegate spends within it without ever touching the Safe's
 * owner keys. That delegate key is exactly an agent session key — scoped and
 * revocable, with the cap enforced onchain rather than by the orchestrator.
 *
 * Everything here builds transactions and never broadcasts them: this package
 * holds no key material by design. Callers send them with their own signer.
 */

import { encodeFunctionData, type Abi } from "viem";
import { getAllowanceModuleDeployment } from "@safe-global/safe-modules-deployments";

/** Pinned so an upgrade is a deliberate change — the package ships two versions. */
export const ALLOWANCE_MODULE_VERSION = "0.1.1";

/** ETH is the zero address in the module's token slot. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

const deployment = getAllowanceModuleDeployment({ version: ALLOWANCE_MODULE_VERSION });

/** ABI of the pinned AllowanceModule. */
export const allowanceModuleAbi = (deployment?.abi ?? []) as Abi;

export type MetaTransaction = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

/** Address of the AllowanceModule on a chain, or a clear error if unavailable. */
export function getAllowanceModuleAddress(chainId: number): `0x${string}` {
  const address = deployment?.networkAddresses?.[String(chainId)];
  if (!address) {
    throw new Error(
      `Safe AllowanceModule ${ALLOWANCE_MODULE_VERSION} is not deployed on chain ${chainId}.`,
    );
  }
  return address as `0x${string}`;
}

/** The module stores amounts as uint96; reject silent truncation up front. */
const UINT96_MAX = (1n << 96n) - 1n;

function assertUint96(amount: bigint, field: string): void {
  if (amount < 0n) throw new Error(`${field} must not be negative.`);
  if (amount > UINT96_MAX) {
    throw new Error(`${field} exceeds uint96 — the AllowanceModule would truncate it.`);
  }
}

export type AllowanceSpec = {
  /** Session key granted the budget. */
  delegate: `0x${string}`;
  /** ERC-20 to cap, or NATIVE_TOKEN for ETH. */
  token?: `0x${string}`;
  /** Cap in the token's smallest unit. */
  amount: bigint;
  /** Refill period in minutes; 0 means one-time with no refill. */
  resetTimeMin?: number;
  /** Epoch minute the refill window is measured from; 0 means now. */
  resetBaseMin?: number;
};

/**
 * Register a delegate on the Safe. Must be executed *by the Safe* — the module
 * reads `msg.sender` as the Safe, so an owner EOA calling it directly would
 * register a delegate against the owner instead.
 */
export function buildAddDelegateTx(chainId: number, delegate: `0x${string}`): MetaTransaction {
  return {
    to: getAllowanceModuleAddress(chainId),
    data: encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "addDelegate",
      args: [delegate],
    }),
    value: 0n,
  };
}

/** Set (or update) a delegate's cap on one token. Executed by the Safe. */
export function buildSetAllowanceTx(chainId: number, spec: AllowanceSpec): MetaTransaction {
  assertUint96(spec.amount, "allowance amount");
  return {
    to: getAllowanceModuleAddress(chainId),
    data: encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "setAllowance",
      args: [
        spec.delegate,
        spec.token ?? NATIVE_TOKEN,
        spec.amount,
        spec.resetTimeMin ?? 0,
        spec.resetBaseMin ?? 0,
      ],
    }),
    value: 0n,
  };
}

/** Revoke a delegate's budget without removing the delegate itself. */
export function buildDeleteAllowanceTx(
  chainId: number,
  delegate: `0x${string}`,
  token: `0x${string}` = NATIVE_TOKEN,
): MetaTransaction {
  return {
    to: getAllowanceModuleAddress(chainId),
    data: encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "deleteAllowance",
      args: [delegate, token],
    }),
    value: 0n,
  };
}

/** Remove a delegate entirely — the revocation path for a compromised session key. */
export function buildRemoveDelegateTx(
  chainId: number,
  delegate: `0x${string}`,
  removeAllowances = true,
): MetaTransaction {
  return {
    to: getAllowanceModuleAddress(chainId),
    data: encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "removeDelegate",
      args: [delegate, removeAllowances],
    }),
    value: 0n,
  };
}

/**
 * The ordered Safe transactions that grant a seat its budget. Both must be
 * executed by the Safe; they can be batched through MultiSend.
 */
export function buildAllowanceSetupTxs(chainId: number, spec: AllowanceSpec): MetaTransaction[] {
  return [buildAddDelegateTx(chainId, spec.delegate), buildSetAllowanceTx(chainId, spec)];
}

export type AllowanceTransferSpec = {
  safe: `0x${string}`;
  token?: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  delegate: `0x${string}`;
};

/**
 * Spend from the allowance. Sent **by the delegate**: an empty signature tells
 * the module to authorize `msg.sender`, which it then checks is a registered
 * delegate. So an agent session key just submits a plain transaction — no
 * EIP-712 signing and no relayer in the path.
 */
export function buildAllowanceTransferTx(
  chainId: number,
  spec: AllowanceTransferSpec,
): MetaTransaction {
  assertUint96(spec.amount, "transfer amount");
  return {
    to: getAllowanceModuleAddress(chainId),
    data: encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "executeAllowanceTransfer",
      args: [
        spec.safe,
        spec.token ?? NATIVE_TOKEN,
        spec.to,
        spec.amount,
        NATIVE_TOKEN, // paymentToken: no gas refund to the relayer
        0n, // payment
        spec.delegate,
        "0x",
      ],
    }),
    value: 0n,
  };
}

export type AllowanceState = {
  /** Cap for the period. */
  amount: bigint;
  /** Cumulative spend within the period. */
  spent: bigint;
  /** What is still spendable now. */
  remaining: bigint;
  /** Refill period in minutes; 0 for a one-time allowance. */
  resetTimeMin: number;
  lastResetMin: number;
  nonce: bigint;
};

/** Minimal reader shape — satisfied by a viem PublicClient. */
export type AllowanceReader = {
  readContract: (args: {
    address: `0x${string}`;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }) => Promise<unknown>;
};

/**
 * Live budget for a seat. The module enforces the cap on cumulative `spent`,
 * not per transfer, so remaining budget must be read rather than inferred from
 * a transfer count.
 */
export async function readAllowance(
  client: AllowanceReader,
  chainId: number,
  safe: `0x${string}`,
  delegate: `0x${string}`,
  token: `0x${string}` = NATIVE_TOKEN,
): Promise<AllowanceState> {
  const raw = (await client.readContract({
    address: getAllowanceModuleAddress(chainId),
    abi: allowanceModuleAbi,
    functionName: "getTokenAllowance",
    args: [safe, delegate, token],
  })) as readonly bigint[];

  const [amount = 0n, spent = 0n, resetTimeMin = 0n, lastResetMin = 0n, nonce = 0n] = raw;
  return {
    amount,
    spent,
    remaining: amount > spent ? amount - spent : 0n,
    resetTimeMin: Number(resetTimeMin),
    lastResetMin: Number(lastResetMin),
    nonce,
  };
}

/** Delegates registered on a Safe (first page). */
export async function readDelegates(
  client: AllowanceReader,
  chainId: number,
  safe: `0x${string}`,
  pageSize = 50,
): Promise<`0x${string}`[]> {
  const result = (await client.readContract({
    address: getAllowanceModuleAddress(chainId),
    abi: allowanceModuleAbi,
    functionName: "getDelegates",
    args: [safe, 0, pageSize],
  })) as readonly [readonly `0x${string}`[], bigint];
  return [...(result[0] ?? [])];
}

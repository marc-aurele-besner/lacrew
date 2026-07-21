/**
 * Real Safe smart-account wiring (PRD F1.8).
 *
 * `@safe-global/protocol-kit` is an optional peer: it loads only when a caller
 * actually connects or predicts a Safe, so the policy surface stays importable
 * without it.
 *
 * Two paths, both real:
 * - `connectSafeWallet` attaches to an existing Safe and reads live owners /
 *   threshold off the chain.
 * - `predictSafeWallet` computes the counterfactual CREATE2 address for a Safe
 *   that is not deployed yet, and `deploySafeWallet` builds the deployment
 *   transaction for a caller-supplied sender.
 */

export type SafeWalletConfig = {
  /** RPC URL the protocol-kit reads through. */
  provider: string;
  /** Signer private key or address, when actions need one. */
  signer?: string;
};

export type SafeWallet = {
  address: `0x${string}`;
  provider: "safe";
  owners: `0x${string}`[];
  threshold: number;
  /** False for a predicted (counterfactual) Safe that has no code yet. */
  deployed: boolean;
};

export type PredictSafeWalletOptions = SafeWalletConfig & {
  owners: `0x${string}`[];
  threshold?: number;
  /** Varying the salt yields a different address for the same owner set. */
  saltNonce?: string;
};

export type ConnectSafeWalletOptions = SafeWalletConfig & {
  safeAddress: `0x${string}`;
};

type SafeConstructor = typeof import("@safe-global/protocol-kit").default;

/** Load the optional peer, surfacing install guidance instead of a module error. */
async function loadSafeKit(): Promise<SafeConstructor> {
  let mod: unknown;
  try {
    mod = await import("@safe-global/protocol-kit");
  } catch {
    throw new Error(
      "@safe-global/protocol-kit is not installed — pnpm add @safe-global/protocol-kit to use Safe wallets.",
    );
  }
  // Dual CJS/ESM package: peel interop layers until the class exposing init().
  let candidate = mod as { default?: unknown; init?: unknown } | undefined;
  while (candidate && typeof candidate.init !== "function" && candidate.default) {
    candidate = candidate.default as typeof candidate;
  }
  if (!candidate || typeof candidate.init !== "function") {
    throw new Error("@safe-global/protocol-kit did not expose Safe.init().");
  }
  return candidate as SafeConstructor;
}

/**
 * protocol-kit requires a numeric salt. Digit strings pass through so callers
 * keep exact control; any other label is hashed (FNV-1a, 64-bit) to a stable
 * decimal, so a readable seat name like "worker-1" still yields a deterministic
 * address instead of throwing inside the SDK.
 */
export function toSaltNonce(salt: string): string {
  if (/^\d+$/.test(salt)) return salt;
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < salt.length; i++) {
    hash = (hash ^ BigInt(salt.charCodeAt(i))) & mask;
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString();
}

/** Shared `Safe.init` config for a not-yet-deployed Safe. */
function predictedSafeConfig(opts: PredictSafeWalletOptions, threshold: number) {
  return {
    provider: opts.provider,
    ...(opts.signer ? { signer: opts.signer } : {}),
    predictedSafe: {
      safeAccountConfig: { owners: opts.owners, threshold },
      ...(opts.saltNonce ? { safeDeploymentConfig: { saltNonce: toSaltNonce(opts.saltNonce) } } : {}),
    },
  };
}

function assertOwners(owners: `0x${string}`[], threshold: number): void {
  if (owners.length === 0) {
    throw new Error("A Safe needs at least one owner.");
  }
  if (threshold < 1 || threshold > owners.length) {
    throw new Error(
      `Safe threshold ${threshold} is out of range for ${owners.length} owner(s).`,
    );
  }
}

/** Attach to a deployed Safe and read its live owner set and threshold. */
export async function connectSafeWallet(opts: ConnectSafeWalletOptions): Promise<SafeWallet> {
  const Safe = await loadSafeKit();
  const notDeployed = new Error(
    `No Safe deployed at ${opts.safeAddress} on this chain — use predictSafeWallet() for a counterfactual address.`,
  );

  // protocol-kit rejects inside init() for a missing proxy; its message does not
  // say which address failed, so both paths surface the same actionable error.
  let safe: Awaited<ReturnType<typeof Safe.init>>;
  try {
    safe = await Safe.init({
      provider: opts.provider,
      ...(opts.signer ? { signer: opts.signer } : {}),
      safeAddress: opts.safeAddress,
    });
  } catch (err) {
    if (/not deployed/i.test(err instanceof Error ? err.message : String(err))) {
      throw notDeployed;
    }
    throw err;
  }
  if (!(await safe.isSafeDeployed())) {
    throw notDeployed;
  }
  const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
  return {
    address: opts.safeAddress,
    provider: "safe",
    owners: owners as `0x${string}`[],
    threshold,
    deployed: true,
  };
}

/**
 * Counterfactual address for a Safe that does not exist yet. The address is
 * deterministic in (owners, threshold, saltNonce), so it can be funded before
 * deployment — the usual pattern for an agent seat awaiting its first budget.
 */
export async function predictSafeWallet(opts: PredictSafeWalletOptions): Promise<SafeWallet> {
  const threshold = opts.threshold ?? 1;
  assertOwners(opts.owners, threshold);
  const Safe = await loadSafeKit();
  const safe = await Safe.init(predictedSafeConfig(opts, threshold));
  const address = (await safe.getAddress()) as `0x${string}`;
  return {
    address,
    provider: "safe",
    owners: opts.owners,
    threshold,
    deployed: await safe.isSafeDeployed(),
  };
}

export type SafeDeploymentTransaction = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  /** The address the Safe will occupy once this transaction lands. */
  safeAddress: `0x${string}`;
};

/**
 * Build the deployment transaction for a predicted Safe. Returned rather than
 * sent: broadcasting needs a funded sender, and this package deliberately holds
 * no key material.
 */
export async function deploySafeWallet(
  opts: PredictSafeWalletOptions,
): Promise<SafeDeploymentTransaction> {
  const threshold = opts.threshold ?? 1;
  assertOwners(opts.owners, threshold);
  const Safe = await loadSafeKit();
  const safe = await Safe.init(predictedSafeConfig(opts, threshold));
  const [safeAddress, tx] = await Promise.all([
    safe.getAddress(),
    safe.createSafeDeploymentTransaction(),
  ]);
  return {
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value || 0),
    safeAddress: safeAddress as `0x${string}`,
  };
}

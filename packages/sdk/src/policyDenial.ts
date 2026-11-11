/**
 * Naming the rule behind a denied propose.
 *
 * The router reverts a denied propose with `UnexpectedVerdict(DENY)` and says
 * nothing about which module denied. Both ledgers answer that afterwards the
 * same way: the first module of the agent's stack that answers DENY when asked
 * on its own. The chain client asks through view calls; the sandbox kernel
 * walks its own state.
 */

import type { PolicyDenial, PolicyModuleKind } from "@lacrew/core";

type Address = `0x${string}`;

/** The custom error a denied propose reverts with, on either ledger. */
export const POLICY_DENIED_ERROR = "UnexpectedVerdict";

const hhmm = (secondOfDay: number): string => {
  const minutes = Math.floor(secondOfDay / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

/** What is known about the denying module when its denial is described. */
export interface DenyingModule {
  address: Address;
  kind: PolicyModuleKind;
  /** The target the propose named. */
  target: Address;
  /** time_window: the module's daily UTC window. */
  startSecondOfDay?: number;
  endSecondOfDay?: number;
  /** The ledger's clock when the module was asked, in unix seconds. */
  nowSec?: number;
}

/** The denial a module of this kind stands for. */
export function describePolicyDenial(module: DenyingModule): PolicyDenial {
  const base = { module: module.address, kind: module.kind };
  if (module.kind === "whitelist") {
    return {
      ...base,
      reason: "target_not_allowlisted",
      detail: `Target ${module.target} is not on the allowlist.`,
      target: module.target,
    };
  }
  if (module.kind === "time_window") {
    const window =
      module.startSecondOfDay !== undefined && module.endSecondOfDay !== undefined
        ? { startSecondOfDay: module.startSecondOfDay, endSecondOfDay: module.endSecondOfDay }
        : null;
    const secondOfDay = module.nowSec !== undefined ? module.nowSec % 86_400 : undefined;
    return {
      ...base,
      reason: "outside_time_window",
      detail: window
        ? `Outside the allowed time window (${hhmm(window.startSecondOfDay)}-${hhmm(window.endSecondOfDay)} UTC${
            secondOfDay !== undefined ? `; the ledger's clock reads ${hhmm(secondOfDay)}` : ""
          }).`
        : "Outside the allowed time window.",
      ...window,
      ...(secondOfDay !== undefined ? { secondOfDay } : {}),
    };
  }
  return {
    ...base,
    reason: "policy_denied",
    detail:
      module.kind === "unknown"
        ? "A policy module of an unrecognised kind denied this action."
        : `The ${module.kind.replace("_", " ")} policy denied this action.`,
  };
}

/**
 * A propose the agent's policy denied, from the chain client.
 *
 * `errorName` is the router's own custom error, so a caller that matched on
 * `UnexpectedVerdict` still does. `denial` is null when the denying module
 * could not be found afterwards (the rule changed in between, or a read failed).
 */
export class PolicyDeniedError extends Error {
  readonly errorName = POLICY_DENIED_ERROR;
  readonly verdict = "DENY" as const;

  constructor(
    readonly denial: PolicyDenial | null,
    options?: { cause?: unknown },
  ) {
    super(
      denial
        ? `${POLICY_DENIED_ERROR}: denied by the ${denial.kind} policy ${denial.module} (${denial.reason}). ${denial.detail}`
        : `${POLICY_DENIED_ERROR}: denied by policy`,
      options,
    );
    this.name = "PolicyDeniedError";
  }
}

/**
 * The denial a failed propose carries, from either ledger: a
 * `PolicyDeniedError` from the chain client, or the sandbox's `SimRevert`
 * whose `args.denial` the kernel's answer was put in. Undefined for an error
 * that is not a policy denial; null for a denial whose module was not found.
 */
export function policyDenialOf(err: unknown): PolicyDenial | null | undefined {
  if (err instanceof PolicyDeniedError) return err.denial;
  if (err instanceof Error && (err as { errorName?: unknown }).errorName === POLICY_DENIED_ERROR) {
    const denial = (err as { args?: { denial?: PolicyDenial | null } }).args?.denial;
    return denial ?? null;
  }
  return undefined;
}

/**
 * What the scenario suite exercises, and what the simulator deliberately does
 * not cover.
 *
 * Read statically off the scenario definitions: a function counts once a step
 * calls it and expects success; an error counts once a step expects it as a
 * revert (or names it in `covers`, for an error a low-level call swallows).
 * The drivers then prove each of those steps does what it says.
 */

import { declares } from "./abiSurface.js";
import { ROLES, type ContractKind, type Ref, type Role } from "./refs.js";
import { isRevert, type Arg, type CallSpec, type Scenario } from "./scenario.js";

/**
 * Every custom error and state-changing function of the simulated contracts
 * that no scenario exercises, with the reason. An entry here is a decision,
 * not a gap: anything else missing from the suite fails the coverage test.
 */
export const NOT_SIMULATED: Record<string, string> = {
  "MockUSDC.faucet":
    "Test-token faucet with a wall-clock cooldown. The sandbox funds a treasury directly; calling it raises SandboxNeedsChainError.",
  "MockUSDC.FaucetCooldown": "Raised only by faucet(), which is not simulated.",
  "MockUSDC.transferWithAuthorization":
    "EIP-3009 settlement (x402) verifies an EIP-712 signature against a chain id. Needs a chain; raises SandboxNeedsChainError.",
  "MockUSDC.cancelAuthorization":
    "EIP-3009 nonce cancellation, part of x402 settlement. Needs a chain; raises SandboxNeedsChainError.",
  "MockUSDC.AuthorizationNotYetValid": "Raised only by transferWithAuthorization.",
  "MockUSDC.AuthorizationExpired": "Raised only by transferWithAuthorization.",
  "MockUSDC.AuthorizationUsedOrCanceled":
    "Raised only by transferWithAuthorization and cancelAuthorization.",
  "MockUSDC.InvalidAuthorizationSignature":
    "Raised only by transferWithAuthorization and cancelAuthorization.",
  "MockUSDC.InvalidShortString":
    "OpenZeppelin EIP712 constructor guard on the domain name; unreachable after deployment.",
  "MockUSDC.StringTooLong":
    "OpenZeppelin EIP712 constructor guard on the domain name; unreachable after deployment.",
  "MockUSDC.ERC20InvalidApprover":
    "OpenZeppelin guard against approving from the zero address; msg.sender is never zero.",
  "MockUSDC.ERC20InvalidSender":
    "OpenZeppelin guard against transferring from the zero address; no caller can be it.",
  "OrgRegistry.GovernorAlreadySet":
    "Declared by the contract but never raised: setGovernor lets the current governor rebind.",
  "Treasury.SafeERC20FailedOperation":
    "SafeERC20 guard for tokens that return false. MockUSDC reverts with its own error instead.",
};

/**
 * Whole contracts the sandbox does not model. They are outside the ABI
 * surface the coverage test checks; listed so the omission is on record.
 */
export const NOT_SIMULATED_CONTRACTS: Record<string, string> = {
  MarketplacePayments:
    "Buyer-to-seller settlement in real tokens. The sandbox client refuses its methods with SandboxNeedsChainError.",
  MockWETH:
    "Second asset stack. A sandbox org has one asset stack (the primary one); multi-asset orgs need a chain.",
};

export interface Exercised {
  /** `Contract.function` called by a step expected to succeed. */
  functions: Set<string>;
  /** `Contract.Error` a step expects to see. */
  errors: Set<string>;
  /** Expectations that name something the contract's ABI does not declare. */
  problems: string[];
}

/** Reverts that are not custom errors of any contract. */
const BUILTIN_REVERTS = new Set(["Panic", "EvmRevert"]);

export function exercised(scenarios: Scenario[]): Exercised {
  const functions = new Set<string>();
  const errors = new Set<string>();
  const problems: string[] = [];

  for (const scenario of scenarios) {
    const deployed = new Map<string, ContractKind>();
    const kindOf = (ref: Ref): ContractKind | null => {
      if (ref.startsWith("@")) return ROLES[ref.slice(1) as Role] ?? null;
      if (ref.startsWith("$")) return deployed.get(ref.slice(1)) ?? null;
      return null;
    };
    const note = (problem: string): void => {
      problems.push(`"${scenario.name}": ${problem}`);
    };

    /** A call that runs: the function itself, and any call carried in its arguments. */
    const called = (call: CallSpec): void => {
      const kind = kindOf(call.to);
      if (kind) {
        if (!declares(kind, "function", call.fn)) note(`${kind} has no function ${call.fn}`);
        functions.add(`${kind}.${call.fn}`);
      }
      const walk = (arg: Arg): void => {
        if (Array.isArray(arg)) arg.forEach(walk);
        else if (typeof arg === "object" && arg !== null && "call" in arg) called(arg.call);
      };
      (call.args ?? []).forEach(walk);
    };

    const expectError = (kind: ContractKind | null, name: string): void => {
      if (BUILTIN_REVERTS.has(name)) return;
      if (!kind) return note(`cannot tell which contract raises ${name}`);
      if (!declares(kind, "error", name)) return note(`${kind} declares no error ${name}`);
      errors.add(`${kind}.${name}`);
    };

    for (const step of scenario.steps) {
      if (step.op === "deploy") {
        if (step.expect) expectError(step.contract, step.expect.revert);
        else deployed.set(step.as, step.contract);
        continue;
      }
      if (step.op !== "call") continue;
      if (isRevert(step.expect)) {
        expectError(step.expect.in ?? kindOf(step.call.to), step.expect.revert);
      } else {
        called(step.call);
      }
      for (const covered of step.covers ?? []) {
        const [kind, name] = covered.split(".") as [ContractKind, string];
        if (declares(kind, "error", name)) errors.add(covered);
        else if (declares(kind, "function", name)) functions.add(covered);
        else note(`covers ${covered}, which ${kind} does not declare`);
      }
    }
  }
  return { functions, errors, problems };
}

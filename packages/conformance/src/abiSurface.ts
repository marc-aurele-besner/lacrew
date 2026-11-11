/**
 * What the simulated contracts expose that can go wrong or change state: every
 * custom error and every state-changing function in their ABIs, by
 * `Contract.name`. The coverage test holds the scenario suite to this list.
 */

import { ABIS, type ContractKind } from "./refs.js";

export interface AbiSurface {
  /** `Contract.function` for every nonpayable or payable function. */
  functions: string[];
  /** `Contract.Error` for every custom error. */
  errors: string[];
}

export function abiSurface(): AbiSurface {
  const functions = new Set<string>();
  const errors = new Set<string>();
  for (const [kind, abi] of Object.entries(ABIS) as Array<
    [ContractKind, (typeof ABIS)[ContractKind]]
  >) {
    for (const item of abi) {
      if (item.type === "error") errors.add(`${kind}.${item.name}`);
      if (
        item.type === "function" &&
        (item.stateMutability === "nonpayable" || item.stateMutability === "payable")
      ) {
        functions.add(`${kind}.${item.name}`);
      }
    }
  }
  return { functions: [...functions].sort(), errors: [...errors].sort() };
}

/** Whether `Contract.name` is an error (or a function) that contract's ABI declares. */
export function declares(kind: ContractKind, type: "error" | "function", name: string): boolean {
  return ABIS[kind].some((item) => item.type === type && item.name === name);
}

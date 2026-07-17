/**
 * Minimal ABI fragments for scaffolding.
 * Mocked: hand-written; not generated from forge artifacts.
 * TODO: Generate from `contracts/out` via wagmi/abitype codegen.
 */

export const orgRegistryAbi = [
  {
    type: "function",
    name: "getNode",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      {
        name: "node",
        type: "tuple",
        components: [
          { name: "account", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "parent", type: "address" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getChildren",
    stateMutability: "view",
    inputs: [{ name: "parent", type: "address" }],
    outputs: [{ name: "children", type: "address[]" }],
  },
] as const;

export const escalationRouterAbi = [
  {
    type: "function",
    name: "propose",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [
      { name: "intentId", type: "uint256" },
      { name: "verdict", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intentId", type: "uint256" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

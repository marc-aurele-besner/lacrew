/**
 * `@lacrew/sdk/sandbox`: the org's rules with no chain underneath.
 *
 * A sandbox is instant, free and resettable, and it is a simulation: it
 * enforces what the contracts enforce, and nothing it reports was ever mined.
 * That is why it lives behind its own subpath and not in the package root —
 * code that means to touch a chain cannot reach this by a plausible import.
 */

export {
  SandboxLacrewClient,
  createSandboxClient,
  type SandboxClientOptions,
  type SandboxCommit,
  type SandboxSnapshot,
} from "./client.js";
export { SandboxNeedsChainError, abiEnv, callByAddress, type CallOutcome } from "./calldata.js";
export { systemClock } from "./clock.js";
export * as kernel from "./kernel/index.js";
export {
  SimRevert,
  manualClock,
  type Clock,
  type ManualClock,
  type SimEvent,
  type World,
} from "./kernel/index.js";

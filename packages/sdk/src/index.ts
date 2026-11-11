/**
 * Public surface of the SDK: the onchain client and the pure helpers.
 *
 * The in-memory test client is deliberately absent. It used to be exported here
 * as `createLacrewClient`, one import away from any production code path, and
 * it answers every read with an organisation that does not exist. It now lives
 * behind `@lacrew/sdk/testing`, which nothing outside a test should import.
 */

export {
  createOnchainClient,
  readAccountBalances,
  readTokenMetadata,
  type TokenLookup,
  FaucetCooldownError,
  type MockTokenFaucet,
  OnchainLacrewClient,
  type OnchainClientOptions,
  type OnchainResolveResult,
  type WriteReceipt,
} from "./onchain.js";
export type {
  IssueSessionInput,
  ProtocolClient,
  ProtocolLedger,
  ProtocolResolveResult,
  SessionKeyLimits,
  WriteRef,
} from "./protocolClient.js";
export { deployOrg, type DeployOrgOptions, type DeployedOrg } from "./deployOrg.js";
export { checkClientPolicy, defaultMockPolicy, type ClientPolicyConfig } from "./policy.js";
export type { ResolveResult } from "./types.js";
export {
  approveIntent,
  denyIntent,
  resolveIntentWithProof,
  SafeExecutionRequired,
  type ResolveIntentOptions,
  type ResolvedIntent,
  type RootSigner,
} from "./approvals.js";
export { simulateIntentAction, type SimulateIntentInput } from "./simulate.js";

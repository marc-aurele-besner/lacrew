/**
 * Test-only surface: an in-memory client and the fixtures behind it.
 *
 * Everything here describes an organisation that does not exist. Import it from
 * a test, never from a code path a user can reach — the whole point of moving
 * it out of the package root is that a plausible-looking import can no longer
 * put invented balances, allowances or audit events in front of somebody.
 */

export {
  LacrewClient,
  createLacrewClient,
  type LacrewClientOptions,
} from "./client.js";
export * from "./fixtures.js";

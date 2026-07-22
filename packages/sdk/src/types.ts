/**
 * Shapes shared by both clients.
 *
 * `ResolveResult` in particular is not test-only — it carries the tx hash of a
 * real onchain resolve — so it lives here rather than inside the test client,
 * which would force production consumers to import from `./testing` for a type
 * that describes chain state.
 */

import type { Intent } from "@lacrew/core";

export type ResolveResult = {
  intent: Intent;
  /** true when the intent climbed to a higher approver instead of closing. */
  escalated: boolean;
  /** Present when the write hit chain (createOnchainClient). */
  txHash?: `0x${string}`;
};

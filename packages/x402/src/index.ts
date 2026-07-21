/**
 * x402 payments for LaCrew agents (PRD F1.15).
 *
 * An agent seat funded through its Safe allowance (F1.8) pays for a metered
 * resource by signing an EIP-3009 authorization. Nothing here custodies keys or
 * broadcasts: signing takes a caller-supplied signer, and settlement is
 * returned as a transaction for whoever relays it.
 */

export * from "./types.js";
export * from "./authorization.js";
export * from "./settle.js";
export * from "./assets.js";

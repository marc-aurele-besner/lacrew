/**
 * Placeholder addresses used as fallbacks when no deployment is configured.
 *
 * These are NOT Anvil accounts — a real local deploy registers
 * 0xf39Fd6e5…, 0x70997970… and 0xCcBcac53…. They are invented, and a runtime
 * that falls back to them is pointed at nothing. The fallbacks are removed once
 * an undeployed chain refuses to start rather than pretending.
 *
 * The demo org fixtures that used to live here moved to `@lacrew/sdk/testing`,
 * so fabricated org data cannot be imported from the package root.
 */

export const MOCK_ROOT = "0x1111111111111111111111111111111111111111" as const;
export const MOCK_MANAGER = "0x2222222222222222222222222222222222222222" as const;
export const MOCK_WORKER = "0x3333333333333333333333333333333333333333" as const;

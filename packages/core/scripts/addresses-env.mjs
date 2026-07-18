#!/usr/bin/env node
/**
 * Print LACREW_* env lines for a local deployment JSON so a divergent chain
 * (e.g. a long-lived Anvil) can be described in .env instead of tracked files.
 *
 * Usage:
 *   node scripts/addresses-env.mjs [chainId] [jsonPath]
 *   pnpm --filter @lacrew/core addresses:env            # chain 31337
 *   pnpm --filter @lacrew/core addresses:env 31337 >> ../../.env
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const chainId = process.argv[2] ?? "31337";
const jsonPath =
  process.argv[3] ?? join(repoRoot, "contracts/deployments", `${chainId}.json`);

/** camelCase → LACREW_SNAKE_CASE, matching ADDRESS_ENV_VARS in src/constants.ts. */
function envVarFor(field) {
  return `LACREW_${field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

const deployment = JSON.parse(readFileSync(jsonPath, "utf8"));
const lines = Object.entries(deployment)
  .filter(([field, value]) => field !== "chainId" && /^0x[a-fA-F0-9]{40}$/.test(String(value)))
  .map(([field, value]) => `${envVarFor(field)}=${value}`)
  .sort();

if (lines.length === 0) {
  console.error(`No address fields found in ${jsonPath}`);
  process.exit(1);
}

console.log(`# Local deployment overrides (chain ${deployment.chainId ?? chainId}) — ${new Date().toISOString()}`);
for (const line of lines) console.log(line);

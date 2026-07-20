/**
 * Load the repo-root .env into process.env when present.
 *
 * The orchestrator gets the same file via `node --env-file`, but that flag
 * hard-fails when the file is missing and .env is gitignored — a fresh clone
 * has none. Loading it here keeps the CLI resolving the same addresses as the
 * orchestrator without breaking `pnpm dev` before setup.
 *
 * Existing process.env values win, so an inline `FOO=bar lacrew …` still works.
 */

import { existsSync, readFileSync } from "node:fs";

/** Parse KEY=VALUE lines; ignores comments, blanks, and `export ` prefixes. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    if (key === "") continue;

    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Apply .env at `path` to process.env. Returns the keys it set.
 *
 * Blank assignments (`PRIVATE_KEY=`) are skipped rather than set to "": the
 * checked-in .env.example carries empty placeholders, and exporting those as
 * empty strings reads as "configured" to consumers that only check presence.
 */
export function loadEnvFile(path: string): string[] {
  if (!existsSync(path)) return [];

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (value === "" || process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

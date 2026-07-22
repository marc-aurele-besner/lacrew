/**
 * Node-only helpers. Kept out of the package root so `@lacrew/core` stays
 * importable from a browser bundle — nothing here may be re-exported from
 * `index.ts`.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** Marks the monorepo root. Present at the top of both this repo and a checkout. */
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

/**
 * The monorepo root, found by walking up from `from`, or null outside a
 * workspace (an installed dependency, a published consumer).
 */
export function findWorkspaceRoot(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(resolve(dir, WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve a shared-store path the same way from every process.
 *
 * The indexer writes this file and the orchestrator reads it, and they run from
 * different working directories under `pnpm --filter`. Resolving a relative
 * `INDEXER_PATH` against `process.cwd()` therefore produced two different
 * absolute paths — `packages/indexer/.lacrew/indexer.json` and
 * `packages/orchestrator/.lacrew/indexer.json` — so the reader tailed a file
 * nobody wrote and the audit trail came back empty with no error anywhere.
 *
 * Relative paths now anchor to the workspace root, which both processes agree
 * on. Absolute paths and URLs are returned untouched.
 */
export function resolveWorkspacePath(raw: string, from: string = process.cwd()): string {
  if (/^https?:\/\//.test(raw)) return raw;
  if (isAbsolute(raw)) return raw;
  return resolve(findWorkspaceRoot(from) ?? from, raw);
}

/** Where the indexer's JSON store lives, honouring `INDEXER_PATH`. */
export const DEFAULT_INDEXER_PATH = ".lacrew/indexer.json";

export function resolveIndexerPath(raw = process.env.INDEXER_PATH): string {
  return resolveWorkspacePath(raw?.trim() || DEFAULT_INDEXER_PATH);
}

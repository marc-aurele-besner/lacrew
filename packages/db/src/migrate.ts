/**
 * Apply SQL migrations from packages/db/drizzle when DATABASE_URL is set.
 * Usage: pnpm --filter @lacrew/db db:migrate
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, getDatabaseUrl } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type MigrateResult = { skipped: boolean };

/**
 * Apply pending migrations. Safe to call at service boot: drizzle records what
 * it has run, so this is a no-op once the schema is current.
 *
 * Without this a service starts against a stale schema and fails at query time
 * with a bare "column does not exist", which reads like a code bug rather than
 * a migration that was never applied.
 */
export async function runDbMigrations(): Promise<MigrateResult> {
  if (!getDatabaseUrl()) return { skipped: true };
  const handle = createDb();
  try {
    await migrate(handle.db, { migrationsFolder: join(__dirname, "../drizzle") });
    return { skipped: false };
  } finally {
    // Own pool, own close — callers keep whatever handle they already had.
    await handle.close();
  }
}

async function main(): Promise<void> {
  if (!getDatabaseUrl()) {
    // Asking to migrate with no database is a config mistake, not a no-op —
    // exit non-zero so a deploy step never reports success on a stale schema.
    console.error(
      "[@lacrew/db] DATABASE_URL is not set — nothing to migrate.\n" +
        "  Set it in lacrew/.env (read by this script) or export it, e.g.\n" +
        "  DATABASE_URL=postgres://lacrew:lacrew@localhost:5432/lacrew",
    );
    process.exitCode = 1;
    return;
  }
  await runDbMigrations();
  console.log("[@lacrew/db] migrations applied");
}

/**
 * True only when this file is the process entrypoint.
 *
 * Matching on the filename alone fires whenever *any* migrate.ts is the
 * entrypoint — @lacrew.xyz/tenancy has one, and importing @lacrew/db from it
 * silently ran these migrations as a side effect. realpath both sides so a
 * pnpm-linked copy still matches itself.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

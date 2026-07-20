/**
 * Apply SQL migrations from packages/db/drizzle when DATABASE_URL is set.
 * Usage: pnpm --filter @lacrew/db db:migrate
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
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
    console.error("[@lacrew/db] DATABASE_URL is not set — skip migrate");
    process.exitCode = 1;
    return;
  }
  await runDbMigrations();
  console.log("[@lacrew/db] migrations applied");
}

const isCli =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));

if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

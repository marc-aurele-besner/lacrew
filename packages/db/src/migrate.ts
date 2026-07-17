/**
 * Apply SQL migrations from packages/db/drizzle when DATABASE_URL is set.
 * Usage: pnpm --filter @lacrew/db db:migrate
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, getDatabaseUrl } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  if (!getDatabaseUrl()) {
    console.error("[@lacrew/db] DATABASE_URL is not set — skip migrate");
    process.exitCode = 1;
    return;
  }
  const handle = createDb();
  try {
    const migrationsFolder = join(__dirname, "../drizzle");
    await migrate(handle.db, { migrationsFolder });
    console.log("[@lacrew/db] migrations applied");
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

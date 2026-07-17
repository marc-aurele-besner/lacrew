/**
 * Postgres client via postgres.js (Neon-compatible) + Drizzle.
 * Local: docker compose → postgres://lacrew:lacrew@localhost:5432/lacrew
 * Hosted: paste Neon DATABASE_URL (sslmode=require).
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type LacrewDb = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: LacrewDb;
  sql: ReturnType<typeof postgres>;
  /** Close the underlying pool. */
  close: () => Promise<void>;
}

export function getDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url || undefined;
}

export function createDb(url = getDatabaseUrl()): DbHandle {
  if (!url) {
    throw new Error("DATABASE_URL is required (Neon or Docker Postgres)");
  }
  const sql = postgres(url, { max: 5, prepare: false });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Ping Postgres; returns false when DATABASE_URL is unset or unreachable. */
export async function checkDbReady(url = getDatabaseUrl()): Promise<boolean> {
  if (!url) return false;
  const handle = createDb(url);
  try {
    await handle.sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

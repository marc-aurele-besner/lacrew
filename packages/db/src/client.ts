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

/**
 * Postgres NOTICEs, minus the ones idempotent migrations cause on every boot.
 * `CREATE TABLE IF NOT EXISTS` and friends emit "already exists, skipping",
 * which postgres.js logs as a full object — noise that trains people to ignore
 * the startup log. Anything unexpected still prints, on one line.
 */
const BENIGN_NOTICE_CODES = new Set([
  "42P07", // duplicate_table
  "42701", // duplicate_column
  "42P06", // duplicate_schema
  "42710", // duplicate_object
  "42P16", // already exists
]);

function logNotice(notice: { code?: string; message?: string }): void {
  if (notice.code && BENIGN_NOTICE_CODES.has(notice.code)) return;
  console.warn(`[@lacrew/db] postgres notice ${notice.code ?? "?"}: ${notice.message ?? ""}`);
}

export function createDb(url = getDatabaseUrl()): DbHandle {
  if (!url) {
    throw new Error("DATABASE_URL is required (Neon or Docker Postgres)");
  }
  const sql = postgres(url, { max: 5, prepare: false, onnotice: logNotice });
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

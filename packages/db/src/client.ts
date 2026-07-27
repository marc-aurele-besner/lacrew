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
 * Postgres schema this runtime owns, or undefined for the default `public`.
 *
 * One database can hold several orchestrators — several environments on one
 * dev box, or a hosted pool where each workspace runs its own runtime — and
 * without this they all write the same tables. That is not a namespacing
 * nicety: two runtimes sharing `orchestrator_audit_events` means each one's
 * audit trail contains the other's, which is the wrong answer to the only
 * question an audit trail exists to answer.
 */
export function getDatabaseSchema(): string | undefined {
  const schema = process.env.DATABASE_SCHEMA?.trim();
  return schema || undefined;
}

/**
 * Postgres identifiers are not interpolatable, and this one may arrive from a
 * hosted control plane naming a tenant. Refuse anything that is not a plain
 * lowercase identifier rather than quoting it into safety — a schema name is
 * config, so a bad one should stop the boot, not become a clever escape.
 */
export function assertValidSchemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(
      `DATABASE_SCHEMA must be a lowercase identifier ([a-z_][a-z0-9_]*, max 63 chars); got ${JSON.stringify(schema)}`,
    );
  }
  return schema;
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

export function createDb(
  url = getDatabaseUrl(),
  schemaName = getDatabaseSchema(),
): DbHandle {
  if (!url) {
    throw new Error("DATABASE_URL is required (Neon or Docker Postgres)");
  }
  // `search_path` on every connection in the pool, not a one-off `SET`: the
  // pool opens connections lazily and reconnects on its own, so a session
  // setting applied once would silently stop applying and later writes would
  // land in `public`.
  const connection = schemaName
    ? { options: `-c search_path=${assertValidSchemaName(schemaName)}` }
    : undefined;
  const sql = postgres(url, {
    max: 5,
    prepare: false,
    onnotice: logNotice,
    ...(connection ? { connection } : {}),
  });
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

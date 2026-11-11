/**
 * The one Postgres pool this process opens for its stores.
 *
 * Every Postgres-backed store takes a `DbHandle` and never opens a pool of its
 * own, so the number of connections a process holds does not grow with the
 * number of stores it builds.
 */

import { createDb, type DbHandle } from "@lacrew/db";

let shared: DbHandle | undefined;

/** The process-wide handle, opened on first use from DATABASE_URL. */
export function sharedDb(): DbHandle {
  return (shared ??= createDb());
}

/** Close the process-wide handle, if one was opened. The next `sharedDb()` opens a new one. */
export async function closeSharedDb(): Promise<void> {
  const handle = shared;
  shared = undefined;
  await handle?.close();
}

import { createDb, insertChainAuditEvent, type DbHandle } from "@lacrew/db";
import type { EventSink, IndexedEvent } from "./types.js";

/**
 * The consumer schema: orchestrator_audit_events, deduped on
 * (tx_hash, log_index). Guardian, Activity, and the dashboard feed all read
 * this table rather than any indexer API.
 */
export class PostgresEventSink implements EventSink {
  readonly name = "postgres";
  private db: DbHandle | undefined;

  async write({ event, txHash, logIndex }: IndexedEvent): Promise<void> {
    // Without both, the row cannot be deduped, so a replay would duplicate it.
    if (txHash == null || logIndex == null) return;
    try {
      this.db ??= createDb();
      await insertChainAuditEvent(this.db, { ...event, txHash, logIndex });
    } catch (err) {
      console.error(
        "[@lacrew/indexer] postgres insert failed:",
        err instanceof Error ? err.message.split("\n")[0] : err,
      );
    }
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
  }
}

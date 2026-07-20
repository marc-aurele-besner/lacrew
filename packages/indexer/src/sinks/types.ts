/**
 * Where decoded chain events go for consumers to read. Postgres is the
 * default; the same provider pattern as ModelProvider / QueueProvider /
 * FlowStore, so a different durable target is a new implementation rather
 * than a branch inside the watcher.
 *
 * This is the *sink* seam, not the *source* seam: swapping the viem watch
 * loop for Ponder is still open (see watcher.ts).
 */

import type { ProtocolEvent } from "@lacrew/core";

export interface IndexedEvent {
  event: ProtocolEvent;
  /** Null for events the chain did not carry a tx for (never, in practice). */
  txHash: string | null;
  logIndex: number | null;
}

export interface EventSink {
  readonly name: string;
  /**
   * Persist one decoded event. Implementations must swallow their own errors:
   * an unreachable sink must not stop the watcher from indexing, nor stop the
   * other sinks from receiving the event.
   */
  write(indexed: IndexedEvent): Promise<void>;
  close(): Promise<void>;
}

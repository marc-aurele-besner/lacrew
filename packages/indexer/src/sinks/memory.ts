import type { EventSink, IndexedEvent } from "./types.js";

/** Records what it was given. For tests and for running with no durable target. */
export class MemoryEventSink implements EventSink {
  readonly name = "memory";
  readonly written: IndexedEvent[] = [];

  async write(indexed: IndexedEvent): Promise<void> {
    this.written.push(indexed);
  }

  async close(): Promise<void> {}
}

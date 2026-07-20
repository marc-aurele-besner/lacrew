export { EventWatcher, type WatcherOptions } from "./watcher.js";
export { loadStore, saveStore, emptyStore, type IndexerStore } from "./store.js";
export {
  createEventSinksFromEnv,
  MemoryEventSink,
  PostgresEventSink,
  type EventSink,
  type IndexedEvent,
} from "./sinks/index.js";

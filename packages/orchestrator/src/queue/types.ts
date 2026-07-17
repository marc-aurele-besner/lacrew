/**
 * Swappable job queue. Default: pg-boss on Postgres.
 * Later: BullMQ + Upstash Redis behind the same interface.
 */

export type QueueJobName = "epoch" | "tick";

export interface QueueStatus {
  provider: "memory" | "pg-boss";
  ready: boolean;
}

export interface QueueHandlers {
  onEpoch?: () => Promise<unknown>;
  onTick?: () => Promise<unknown>;
}

export interface QueueProvider {
  readonly name: QueueStatus["provider"];
  start(handlers?: QueueHandlers): Promise<void>;
  stop(): Promise<void>;
  /** Enqueue a one-shot job. */
  enqueue(name: QueueJobName, data?: Record<string, unknown>): Promise<string | null>;
  /** Schedule recurring epoch jobs (cron). No-op for memory unless polled. */
  scheduleEpoch(cron: string): Promise<void>;
  status(): QueueStatus;
}

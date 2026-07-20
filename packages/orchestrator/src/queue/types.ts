/**
 * Swappable job queue. Default: pg-boss on Postgres.
 * Later: BullMQ + Upstash Redis behind the same interface.
 */

export type QueueJobName = "epoch" | "tick" | "flow-cron";

export interface QueueStatus {
  provider: "memory" | "pg-boss";
  ready: boolean;
  /** Active epoch schedule expression (cron or `interval:<ms>`). */
  epochSchedule?: string | null;
  /** Active flow-cron sweep expression (cron or `interval:<ms>`). */
  flowCronSchedule?: string | null;
}

export interface QueueHandlers {
  onEpoch?: () => Promise<unknown>;
  onTick?: () => Promise<unknown>;
  /** Sweep cron-triggered flows for the current minute. */
  onFlowCron?: () => Promise<unknown>;
}

export interface QueueProvider {
  readonly name: QueueStatus["provider"];
  start(handlers?: QueueHandlers): Promise<void>;
  stop(): Promise<void>;
  /** Enqueue a one-shot job. */
  enqueue(name: QueueJobName, data?: Record<string, unknown>): Promise<string | null>;
  /** Schedule recurring epoch jobs (cron). No-op for memory unless polled. */
  scheduleEpoch(cron: string): Promise<void>;
  /**
   * Schedule the recurring sweep that fires due cron flows. Durable providers
   * must dispatch it to exactly one worker per tick — running the sweep in
   * every replica fires each flow once per replica.
   */
  scheduleFlowCron(cron: string): Promise<void>;
  status(): QueueStatus;
}

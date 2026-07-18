import type { QueueHandlers, QueueJobName, QueueProvider, QueueStatus } from "./types.js";

/** In-process queue when DATABASE_URL is unset (Anvil / mock demos). */
export class InMemoryQueue implements QueueProvider {
  readonly name = "memory" as const;
  private ready = false;
  private handlers: QueueHandlers = {};
  private readonly pending: Array<{ name: QueueJobName; data?: Record<string, unknown> }> = [];
  private epochTimer: ReturnType<typeof setInterval> | null = null;
  private epochSchedule: string | null = null;

  async start(handlers: QueueHandlers = {}): Promise<void> {
    this.handlers = handlers;
    this.ready = true;
    while (this.pending.length > 0) {
      const job = this.pending.shift();
      if (job) await this.run(job.name);
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.epochTimer) {
      clearInterval(this.epochTimer);
      this.epochTimer = null;
    }
    this.epochSchedule = null;
  }

  async enqueue(name: QueueJobName, _data?: Record<string, unknown>): Promise<string | null> {
    if (!this.ready) {
      this.pending.push({ name, data: _data });
      return `mem_pending_${name}_${Date.now()}`;
    }
    await this.run(name);
    return `mem_${name}_${Date.now()}`;
  }

  /**
   * Recurring epoch for demos without Postgres.
   * Opt-in via EPOCH_INTERVAL_MS (>0). Cron string is ignored for memory
   * (pg-boss owns real cron); HTTP POST /epoch remains available.
   */
  async scheduleEpoch(_cron: string): Promise<void> {
    if (this.epochTimer) {
      clearInterval(this.epochTimer);
      this.epochTimer = null;
    }

    const ms = Number(process.env.EPOCH_INTERVAL_MS ?? 0);
    if (!Number.isFinite(ms) || ms <= 0) {
      this.epochSchedule = null;
      return;
    }

    this.epochSchedule = `interval:${ms}`;
    this.epochTimer = setInterval(() => {
      void this.run("epoch").catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[@lacrew/orchestrator] memory epoch tick failed", err);
      });
    }, ms);
    this.epochTimer.unref?.();
  }

  status(): QueueStatus {
    return {
      provider: "memory",
      ready: this.ready,
      epochSchedule: this.epochSchedule,
    };
  }

  private async run(name: QueueJobName): Promise<void> {
    if (name === "epoch" && this.handlers.onEpoch) await this.handlers.onEpoch();
    if (name === "tick" && this.handlers.onTick) await this.handlers.onTick();
  }
}

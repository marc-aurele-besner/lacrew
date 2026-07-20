import type { QueueHandlers, QueueJobName, QueueProvider, QueueStatus } from "./types.js";

/** Sweep cadence for cron flows — fine for minute-resolution schedules. */
const DEFAULT_FLOW_CRON_POLL_MS = 20_000;

function flowCronPollMs(): number {
  const ms = Number(process.env.FLOW_CRON_POLL_MS ?? 0);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_FLOW_CRON_POLL_MS;
}

/** In-process queue when DATABASE_URL is unset (Anvil / mock demos). */
export class InMemoryQueue implements QueueProvider {
  readonly name = "memory" as const;
  private ready = false;
  private handlers: QueueHandlers = {};
  private readonly pending: Array<{ name: QueueJobName; data?: Record<string, unknown> }> = [];
  private epochTimer: ReturnType<typeof setInterval> | null = null;
  private epochSchedule: string | null = null;
  private flowCronTimer: ReturnType<typeof setInterval> | null = null;
  private flowCronSchedule: string | null = null;

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
    if (this.flowCronTimer) {
      clearInterval(this.flowCronTimer);
      this.flowCronTimer = null;
    }
    this.flowCronSchedule = null;
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

  /**
   * Single process, so polling in-process is already the one sweeper. Unlike
   * epochs this is on by default: cron flows are expected to fire detached.
   * The cron string is ignored — `runCronDue` matches schedules per flow.
   */
  async scheduleFlowCron(_cron: string): Promise<void> {
    if (this.flowCronTimer) {
      clearInterval(this.flowCronTimer);
      this.flowCronTimer = null;
    }

    const ms = flowCronPollMs();
    this.flowCronSchedule = `interval:${ms}`;
    this.flowCronTimer = setInterval(() => {
      void this.run("flow-cron").catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[@lacrew/orchestrator] memory flow-cron sweep failed", err);
      });
    }, ms);
    this.flowCronTimer.unref?.();
  }

  status(): QueueStatus {
    return {
      provider: "memory",
      ready: this.ready,
      epochSchedule: this.epochSchedule,
      flowCronSchedule: this.flowCronSchedule,
    };
  }

  private async run(name: QueueJobName): Promise<void> {
    if (name === "epoch" && this.handlers.onEpoch) await this.handlers.onEpoch();
    if (name === "tick" && this.handlers.onTick) await this.handlers.onTick();
    if (name === "flow-cron" && this.handlers.onFlowCron) await this.handlers.onFlowCron();
  }
}

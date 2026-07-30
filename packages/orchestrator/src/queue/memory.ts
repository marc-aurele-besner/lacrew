import type { QueueHandlers, QueueJobName, QueueProvider, QueueStatus } from "./types.js";

/** Sweep cadence for cron flows — fine for minute-resolution schedules. */
const DEFAULT_FLOW_CRON_POLL_MS = 20_000;

/** Poll interval for the preset epoch crons, so a reschedule is observable
 *  without Postgres. Arbitrary crons aren't parsed here — durable mode owns that. */
const PRESET_CRON_MS: Record<string, number> = {
  "0 * * * *": 3_600_000,
  "0 0 * * *": 86_400_000,
  "0 0 * * 0": 604_800_000,
  "0 0 1 * *": 2_629_746_000,
};

/** setInterval clamps to a signed 32-bit delay; longer schedules can't tick here. */
const MAX_TIMER_MS = 2_147_483_647;

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
  /** Detached webhook jobs still in flight; awaited by `drain()`. */
  private readonly inflight = new Set<Promise<void>>();

  async start(handlers: QueueHandlers = {}): Promise<void> {
    this.handlers = handlers;
    this.ready = true;
    while (this.pending.length > 0) {
      const job = this.pending.shift();
      if (job) await this.run(job.name, job.data);
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

  async enqueue(name: QueueJobName, data?: Record<string, unknown>): Promise<string | null> {
    if (!this.ready) {
      this.pending.push({ name, data });
      return `mem_pending_${name}_${Date.now()}`;
    }
    if (name === "webhook") {
      // Detached on purpose: the caller is an HTTP handler answering a webhook
      // producer, and awaiting the flow here would hold that socket open for
      // the whole run — the thing durable mode exists to avoid. Tracked so
      // tests (and shutdown) have something to wait on.
      const job = this.run(name, data)
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[@lacrew/orchestrator] memory webhook job failed", err);
        })
        .finally(() => {
          this.inflight.delete(job);
        });
      this.inflight.add(job);
      return `mem_${name}_${Date.now()}`;
    }
    await this.run(name, data);
    return `mem_${name}_${Date.now()}`;
  }

  /**
   * Settle detached jobs. Durable providers have a real queue to inspect;
   * in-process there is nowhere else to look, so this is how a caller waits.
   */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  /**
   * Recurring epoch for demos without Postgres. Re-entrant, so it also serves
   * runtime reschedules. `EPOCH_INTERVAL_MS` (>0) forces a fast dev loop and
   * wins; otherwise a preset cron yields its poll interval so the reschedule is
   * observable. Arbitrary crons (or intervals past setInterval's range) record
   * the schedule for status but don't tick here — HTTP POST /epoch still runs.
   */
  async scheduleEpoch(cron: string): Promise<void> {
    if (this.epochTimer) {
      clearInterval(this.epochTimer);
      this.epochTimer = null;
    }

    const override = Number(process.env.EPOCH_INTERVAL_MS ?? 0);
    const hasOverride = Number.isFinite(override) && override > 0;
    const presetMs = PRESET_CRON_MS[cron.trim().replace(/\s+/g, " ")] ?? null;
    const ms = hasOverride ? override : presetMs;

    this.epochSchedule = hasOverride
      ? `interval:${override}`
      : presetMs != null
        ? cron.trim().replace(/\s+/g, " ")
        : null;

    if (ms == null || ms > MAX_TIMER_MS) return;

    this.epochTimer = setInterval(() => {
      void this.run("epoch").catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[@lacrew/orchestrator] memory epoch tick failed", err);
      });
    }, ms);
    this.epochTimer.unref?.();
  }

  async getScheduledEpochCron(): Promise<string | null> {
    // In-process only: nothing persists across restarts, so boot has no prior
    // cadence to honor — the env default reapplies on each start.
    return null;
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

  private async run(name: QueueJobName, data?: Record<string, unknown>): Promise<void> {
    if (name === "epoch" && this.handlers.onEpoch) await this.handlers.onEpoch();
    if (name === "tick" && this.handlers.onTick) await this.handlers.onTick();
    if (name === "flow-cron" && this.handlers.onFlowCron) await this.handlers.onFlowCron();
    if (name === "webhook" && this.handlers.onWebhook) await this.handlers.onWebhook(data ?? {});
  }
}

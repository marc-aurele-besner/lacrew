/**
 * Postgres-backed jobs via pg-boss (Neon or Docker).
 * TODO: BullMQ + Upstash Redis adapter when concurrency needs Redis.
 */

import PgBoss from "pg-boss";
import { assertValidSchemaName, getDatabaseSchema, getDatabaseUrl } from "@lacrew/db";
import type { QueueHandlers, QueueJobName, QueueProvider, QueueStatus } from "./types.js";

const QUEUES: QueueJobName[] = ["epoch", "tick", "flow-cron"];

export class PgBossQueue implements QueueProvider {
  readonly name = "pg-boss" as const;
  private boss: PgBoss | null = null;
  private ready = false;
  private epochSchedule: string | null = null;
  private flowCronSchedule: string | null = null;

  constructor(
    private readonly connectionString = getDatabaseUrl(),
    private readonly schema = getDatabaseSchema(),
  ) {}

  async start(handlers: QueueHandlers = {}): Promise<void> {
    if (!this.connectionString) {
      throw new Error("DATABASE_URL is required for PgBossQueue");
    }
    // pg-boss defaults to a `pgboss` schema, which every runtime against this
    // database shares — so two orchestrators would share one job queue and
    // either could `work()` the other's epoch or tick. That is worse than
    // sharing a table: it is one workspace's schedule executing under another
    // workspace's keys. When this runtime owns a schema, its queue lives there
    // too. (The non-graceful stop below is the scar from the shared case.)
    // The union of the two constructor overloads is not itself assignable to
    // either, so pick the call rather than the argument.
    const boss = this.schema
      ? new PgBoss({
          connectionString: this.connectionString,
          schema: assertValidSchemaName(this.schema),
        })
      : new PgBoss(this.connectionString);
    this.boss = boss;
    await boss.start();
    for (const q of QUEUES) {
      await boss.createQueue(q);
    }
    if (handlers.onEpoch) {
      await boss.work("epoch", async () => {
        await handlers.onEpoch!();
      });
    }
    if (handlers.onTick) {
      await boss.work("tick", async () => {
        await handlers.onTick!();
      });
    }
    if (handlers.onFlowCron) {
      await boss.work("flow-cron", async () => {
        await handlers.onFlowCron!();
      });
    }
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.boss) {
      // Non-graceful: avoid hanging when another process also owns workers on this DB.
      await this.boss.stop({ graceful: false, timeout: 2_000 });
      this.boss = null;
    }
  }

  async enqueue(name: QueueJobName, data: Record<string, unknown> = {}): Promise<string | null> {
    if (!this.boss || !this.ready) throw new Error("PgBossQueue not started");
    return this.boss.send(name, data);
  }

  async scheduleEpoch(cron: string): Promise<void> {
    if (!this.boss || !this.ready) throw new Error("PgBossQueue not started");
    // pg-boss keys schedules by queue name, so this upserts the single "epoch"
    // schedule — the same call serves boot wiring and runtime reschedules.
    await this.boss.schedule("epoch", cron, {});
    this.epochSchedule = cron;
  }

  async getScheduledEpochCron(): Promise<string | null> {
    if (!this.boss || !this.ready) throw new Error("PgBossQueue not started");
    // Schedules live in Postgres, so a runtime-set cadence survives restart and
    // boot can read it back rather than reapplying the env default over it.
    const schedules = await this.boss.getSchedules();
    return schedules.find((s) => s.name === "epoch")?.cron ?? null;
  }

  /**
   * pg-boss holds a scheduling lock on the queue name, so N replicas sharing a
   * database still enqueue one sweep per tick, and one worker claims it.
   */
  async scheduleFlowCron(cron: string): Promise<void> {
    if (!this.boss || !this.ready) throw new Error("PgBossQueue not started");
    await this.boss.schedule("flow-cron", cron, {});
    this.flowCronSchedule = cron;
  }

  status(): QueueStatus {
    return {
      provider: "pg-boss",
      ready: this.ready,
      epochSchedule: this.epochSchedule,
      flowCronSchedule: this.flowCronSchedule,
    };
  }
}

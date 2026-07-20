/**
 * Postgres-backed jobs via pg-boss (Neon or Docker).
 * TODO: BullMQ + Upstash Redis adapter when concurrency needs Redis.
 */

import PgBoss from "pg-boss";
import { getDatabaseUrl } from "@lacrew/db";
import type { QueueHandlers, QueueJobName, QueueProvider, QueueStatus } from "./types.js";

const QUEUES: QueueJobName[] = ["epoch", "tick", "flow-cron"];

export class PgBossQueue implements QueueProvider {
  readonly name = "pg-boss" as const;
  private boss: PgBoss | null = null;
  private ready = false;
  private epochSchedule: string | null = null;
  private flowCronSchedule: string | null = null;

  constructor(private readonly connectionString = getDatabaseUrl()) {}

  async start(handlers: QueueHandlers = {}): Promise<void> {
    if (!this.connectionString) {
      throw new Error("DATABASE_URL is required for PgBossQueue");
    }
    const boss = new PgBoss(this.connectionString);
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
    await this.boss.schedule("epoch", cron, {});
    this.epochSchedule = cron;
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

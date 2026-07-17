/**
 * Postgres-backed jobs via pg-boss (Neon or Docker).
 * TODO: BullMQ + Upstash Redis adapter when concurrency needs Redis.
 */

import PgBoss from "pg-boss";
import { getDatabaseUrl } from "@lacrew/db";
import type { QueueHandlers, QueueJobName, QueueProvider, QueueStatus } from "./types.js";

const QUEUES: QueueJobName[] = ["epoch", "tick"];

export class PgBossQueue implements QueueProvider {
  readonly name = "pg-boss" as const;
  private boss: PgBoss | null = null;
  private ready = false;

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
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.boss) {
      await this.boss.stop({ graceful: true, timeout: 5_000 });
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
  }

  status(): QueueStatus {
    return { provider: "pg-boss", ready: this.ready };
  }
}

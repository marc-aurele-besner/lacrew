import type { QueueHandlers, QueueJobName, QueueProvider, QueueStatus } from "./types.js";

/** In-process queue when DATABASE_URL is unset (Anvil / mock demos). */
export class InMemoryQueue implements QueueProvider {
  readonly name = "memory" as const;
  private ready = false;
  private handlers: QueueHandlers = {};
  private readonly pending: Array<{ name: QueueJobName; data?: Record<string, unknown> }> = [];

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
  }

  async enqueue(name: QueueJobName, _data?: Record<string, unknown>): Promise<string | null> {
    if (!this.ready) {
      this.pending.push({ name, data: _data });
      return `mem_pending_${name}_${Date.now()}`;
    }
    await this.run(name);
    return `mem_${name}_${Date.now()}`;
  }

  async scheduleEpoch(_cron: string): Promise<void> {
    // Memory provider has no cron daemon; use HTTP POST /epoch or enqueue("epoch").
  }

  status(): QueueStatus {
    return { provider: "memory", ready: this.ready };
  }

  private async run(name: QueueJobName): Promise<void> {
    if (name === "epoch" && this.handlers.onEpoch) await this.handlers.onEpoch();
    if (name === "tick" && this.handlers.onTick) await this.handlers.onTick();
  }
}

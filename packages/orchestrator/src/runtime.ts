/**
 * Agent runtime: schedule work, propose intents, listen for events.
 * Mocked: single in-process crew loop over demo org data.
 * TODO: BullMQ + Redis scheduling, OpenRouter model calls, MCP tool protocol.
 */

import { createLacrewClient, type LacrewClient } from "@lacrew/sdk";
import { MOCK_WORKER, type Intent, type SessionKey } from "@lacrew/core";
import { issueSession, isSessionExpired, revokeSession } from "./sessions.js";

export interface CrewRuntimeOptions {
  client?: LacrewClient;
  workerAgent?: `0x${string}`;
}

export class CrewRuntime {
  private readonly client: LacrewClient;
  private readonly workerAgent: `0x${string}`;
  private session: SessionKey | null = null;

  constructor(options: CrewRuntimeOptions = {}) {
    this.client = options.client ?? createLacrewClient({ useMock: true });
    this.workerAgent = options.workerAgent ?? MOCK_WORKER;
  }

  /** Boot (or rotate) a session key for the worker. */
  async boot(): Promise<SessionKey> {
    if (this.session && !isSessionExpired(this.session)) {
      return this.session;
    }
    this.session = issueSession({
      agent: this.workerAgent,
      scopes: ["spend:whitelist", "propose:intent"],
    });
    return this.session;
  }

  /**
   * Run one mocked work tick: propose a spend intent.
   * TODO: Replace fixed target/value with agent-planned tool calls.
   */
  async tick(): Promise<{ session: SessionKey; intentId: string; verdict: string }> {
    const session = await this.boot();
    if (isSessionExpired(session)) {
      this.session = revokeSession(session);
      throw new Error("Session expired; call boot() to rotate");
    }

    // Mocked over-budget spend so escalation path is exercised.
    const result = await this.client.proposeIntent({
      agent: this.workerAgent,
      target: "0x4444444444444444444444444444444444444444",
      value: 75n * 10n ** 6n,
      data: "0x",
    });

    return { session, intentId: result.intentId, verdict: result.verdict };
  }

  async listPending(): Promise<Intent[]> {
    return this.client.getPendingIntents();
  }
}

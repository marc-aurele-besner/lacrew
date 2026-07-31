/**
 * Pluggable model access (PRD F1.7).
 * Feature/runtime code depends on ModelProvider — never imports OpenRouter SDKs.
 */

export type ModelCompleteInput = {
  system?: string;
  prompt: string;
  model?: string;
  /**
   * Optional JSON-ish context for agent crews (org id, intent id, …).
   *
   * Cost budgets (F2.28) read `crewId`, `agentId`, `flowId` and `runId` from
   * here. They are advisory context, never authority: a call that names no crew
   * is still metered, under `unattributed`, so the total an operator reads is
   * never lower than the bill they pay.
   */
  meta?: Record<string, unknown>;
};

export type ModelCompleteResult = {
  text: string;
  model: string;
  mocked?: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    /**
     * What the provider says this call cost, in dollars, when it says. Always
     * preferred over the local price table — it is the number that will appear
     * on the bill. Most providers return nothing here, and a call nobody could
     * price is counted as unpriced rather than as free.
     */
    costUsd?: number;
  };
};

export interface ModelProvider {
  readonly name: string;
  complete(input: ModelCompleteInput): Promise<ModelCompleteResult>;
}

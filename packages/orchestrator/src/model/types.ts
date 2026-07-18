/**
 * Pluggable model access (PRD F1.7).
 * Feature/runtime code depends on ModelProvider — never imports OpenRouter SDKs.
 */

export type ModelCompleteInput = {
  system?: string;
  prompt: string;
  model?: string;
  /** Optional JSON-ish context for agent crews (org id, intent id, …). */
  meta?: Record<string, unknown>;
};

export type ModelCompleteResult = {
  text: string;
  model: string;
  mocked?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number };
};

export interface ModelProvider {
  readonly name: string;
  complete(input: ModelCompleteInput): Promise<ModelCompleteResult>;
}

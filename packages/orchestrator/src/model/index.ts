import type { ModelProvider } from "./types.js";
import { MemoryModelProvider } from "./memory.js";
import { AnthropicModelProvider } from "./anthropic.js";
import { OpenAIModelProvider } from "./openai.js";
import { OpenRouterModelProvider } from "./openrouter.js";

export type { ModelProvider, ModelCompleteInput, ModelCompleteResult } from "./types.js";
export { MemoryModelProvider } from "./memory.js";
export { AnthropicModelProvider } from "./anthropic.js";
export { OpenAIModelProvider } from "./openai.js";
export { OpenRouterModelProvider } from "./openrouter.js";
export { withInferenceBudget, modelPricesFromEnv, subjectOfInput } from "./budgeted.js";

/** Provider ids accepted by `LACREW_MODEL_PROVIDER`. */
export const MODEL_PROVIDER_IDS = ["memory", "anthropic", "openai", "openrouter"] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

function build(id: ModelProviderId): ModelProvider {
  switch (id) {
    case "anthropic":
      return new AnthropicModelProvider();
    case "openai":
      return new OpenAIModelProvider();
    case "openrouter":
      return new OpenRouterModelProvider();
    case "memory":
      return new MemoryModelProvider();
  }
}

/**
 * `LACREW_MODEL_PROVIDER` selects explicitly; otherwise the first configured key
 * wins, direct vendor keys ahead of the router because a deployment holding both
 * more often means the direct one. Memory stub when nothing is configured.
 */
export function createModelProviderFromEnv(): ModelProvider {
  const requested = process.env.LACREW_MODEL_PROVIDER?.trim().toLowerCase();
  if (requested) {
    if (!(MODEL_PROVIDER_IDS as readonly string[]).includes(requested)) {
      throw new Error(
        `unknown_model_provider: ${requested} (expected ${MODEL_PROVIDER_IDS.join(", ")})`,
      );
    }
    return build(requested as ModelProviderId);
  }
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicModelProvider();
  if (process.env.OPENAI_API_KEY) return new OpenAIModelProvider();
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterModelProvider();
  return new MemoryModelProvider();
}

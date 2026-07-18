import type { ModelProvider } from "./types.js";
import { MemoryModelProvider } from "./memory.js";
import { OpenRouterModelProvider } from "./openrouter.js";

export type { ModelProvider, ModelCompleteInput, ModelCompleteResult } from "./types.js";
export { MemoryModelProvider } from "./memory.js";
export { OpenRouterModelProvider } from "./openrouter.js";

/** OpenRouter when OPENROUTER_API_KEY is set; otherwise memory stub. */
export function createModelProviderFromEnv(): ModelProvider {
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterModelProvider();
  return new MemoryModelProvider();
}

import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./types.js";

/** Deterministic stub used when no API key is configured. */
export class MemoryModelProvider implements ModelProvider {
  readonly name = "memory";

  async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
    const model = input.model ?? "memory/stub";
    const preview = input.prompt.replace(/\s+/g, " ").trim().slice(0, 120);
    return {
      text: `[${model}] acknowledged: ${preview || "(empty prompt)"}`,
      model,
      mocked: true,
    };
  }
}

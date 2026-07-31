import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./types.js";
import { MemoryModelProvider } from "./memory.js";

const DEFAULT_MODEL = "openrouter/auto";

/**
 * OpenRouter HTTP client (no SDK). Falls back to MemoryModelProvider without a key.
 */
export class OpenRouterModelProvider implements ModelProvider {
  readonly name = "openrouter";
  private readonly fallback = new MemoryModelProvider();

  constructor(
    private readonly apiKey = process.env.OPENROUTER_API_KEY,
    private readonly baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  ) {}

  async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
    if (!this.apiKey) {
      return this.fallback.complete(input);
    }

    const model = input.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
    const messages: Array<{ role: string; content: string }> = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    messages.push({ role: "user", content: input.prompt });

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_SITE_URL ?? "https://lacrew.xyz",
        "x-title": "LaCrew Orchestrator",
      },
      body: JSON.stringify({ model, messages }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`openrouter_${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model: data.model ?? model,
      mocked: false,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        // The router prices the call itself when it reports usage accounting.
        // Passed through so a cost budget bills the routed model's real price
        // rather than a local table's guess at whatever `openrouter/auto` picked.
        ...(typeof data.usage?.cost === "number" ? { costUsd: data.usage.cost } : {}),
      },
    };
  }
}

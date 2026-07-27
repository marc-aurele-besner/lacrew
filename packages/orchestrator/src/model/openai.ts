import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./types.js";
import { MemoryModelProvider } from "./memory.js";

const DEFAULT_MODEL = "gpt-5";

/**
 * OpenAI chat completions client (no SDK). Falls back to MemoryModelProvider
 * without a key. `OPENAI_BASE_URL` also covers Azure/compatible endpoints.
 */
export class OpenAIModelProvider implements ModelProvider {
  readonly name = "openai";
  private readonly fallback = new MemoryModelProvider();

  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  ) {}

  async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
    if (!this.apiKey) {
      return this.fallback.complete(input);
    }

    const model = input.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    const messages: Array<{ role: string; content: string }> = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    messages.push({ role: "user", content: input.prompt });

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (process.env.OPENAI_ORG_ID) headers["openai-organization"] = process.env.OPENAI_ORG_ID;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`openai_${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
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
      },
    };
  }
}

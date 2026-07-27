import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./types.js";
import { MemoryModelProvider } from "./memory.js";

const DEFAULT_MODEL = "claude-opus-5";
/** Pinned rather than floating: a version bump can change the response shape. */
const API_VERSION = "2023-06-01";
/** The Messages API requires an explicit output cap; thinking counts against it. */
const DEFAULT_MAX_TOKENS = 16000;

/**
 * Anthropic Messages API client (no SDK). Falls back to MemoryModelProvider
 * without a key.
 */
export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic";
  private readonly fallback = new MemoryModelProvider();

  constructor(
    private readonly apiKey = process.env.ANTHROPIC_API_KEY,
    private readonly baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
  ) {}

  async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
    if (!this.apiKey) {
      return this.fallback.complete(input);
    }

    const model = input.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS) || DEFAULT_MAX_TOKENS;

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      // The system prompt is a top-level field here, not a message role.
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(input.system ? { system: input.system } : {}),
        messages: [{ role: "user", content: input.prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`anthropic_${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      model?: string;
      stop_reason?: string;
      stop_details?: { category?: string | null };
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    // A declined request is HTTP 200 with an empty or partial body, so it has to
    // be raised rather than returned as if it were an answer.
    if (data.stop_reason === "refusal") {
      throw new Error(`anthropic_refusal: ${data.stop_details?.category ?? "unspecified"}`);
    }

    // Thinking blocks can precede the answer, so the text blocks are collected
    // rather than reading content[0].
    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    return {
      text,
      model: data.model ?? model,
      mocked: false,
      usage: {
        promptTokens: data.usage?.input_tokens,
        completionTokens: data.usage?.output_tokens,
      },
    };
  }
}

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AnthropicModelProvider } from "./anthropic.js";
import { OpenAIModelProvider } from "./openai.js";
import { createModelProviderFromEnv } from "./index.js";

const KEYS = [
  "LACREW_MODEL_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_MAX_TOKENS",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENROUTER_API_KEY",
] as const;

const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = realFetch;
});

function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

/** Captures the single outbound request so the wire shape can be asserted. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return calls;
}

describe("createModelProviderFromEnv", () => {
  it("defaults to memory without any key", () => {
    clearEnv();
    assert.equal(createModelProviderFromEnv().name, "memory");
  });

  it("prefers direct vendor keys over the router", () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-router";
    assert.equal(createModelProviderFromEnv().name, "openrouter");
    process.env.OPENAI_API_KEY = "sk-openai";
    assert.equal(createModelProviderFromEnv().name, "openai");
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    assert.equal(createModelProviderFromEnv().name, "anthropic");
  });

  it("lets LACREW_MODEL_PROVIDER override key order", () => {
    clearEnv();
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.LACREW_MODEL_PROVIDER = "openrouter";
    assert.equal(createModelProviderFromEnv().name, "openrouter");
  });

  it("refuses an unknown provider id rather than silently stubbing", () => {
    clearEnv();
    process.env.LACREW_MODEL_PROVIDER = "llama";
    assert.throws(() => createModelProviderFromEnv(), /unknown_model_provider: llama/);
  });
});

describe("AnthropicModelProvider", () => {
  it("falls back to the memory stub without a key", async () => {
    const out = await new AnthropicModelProvider(undefined).complete({ prompt: "hi" });
    assert.equal(out.mocked, true);
  });

  it("sends the Messages API shape and reads text blocks past thinking", async () => {
    clearEnv();
    const calls = stubFetch({
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "pending: 2" },
      ],
      model: "claude-opus-5",
      usage: { input_tokens: 11, output_tokens: 4 },
    });

    const out = await new AnthropicModelProvider("sk-test", "https://api.test/v1").complete({
      prompt: "how many escalations?",
      system: "You are terse.",
    });

    assert.equal(out.text, "pending: 2");
    assert.equal(out.mocked, false);
    assert.deepEqual(out.usage, { promptTokens: 11, completionTokens: 4 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.test/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-test");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    const sent = JSON.parse(calls[0]!.init.body as string);
    assert.equal(sent.model, "claude-opus-5");
    // The cap is required by the API, and the system prompt is not a message.
    assert.ok(sent.max_tokens > 0);
    assert.equal(sent.system, "You are terse.");
    assert.deepEqual(sent.messages, [{ role: "user", content: "how many escalations?" }]);
  });

  it("raises a refusal instead of returning empty text as an answer", async () => {
    clearEnv();
    stubFetch({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" } });
    await assert.rejects(
      new AnthropicModelProvider("sk-test").complete({ prompt: "…" }),
      /anthropic_refusal: cyber/,
    );
  });

  it("raises the status on a non-2xx", async () => {
    clearEnv();
    stubFetch({ error: "bad" }, 401);
    await assert.rejects(
      new AnthropicModelProvider("sk-test").complete({ prompt: "…" }),
      /anthropic_401/,
    );
  });
});

describe("OpenAIModelProvider", () => {
  it("falls back to the memory stub without a key", async () => {
    const out = await new OpenAIModelProvider(undefined).complete({ prompt: "hi" });
    assert.equal(out.mocked, true);
  });

  it("sends chat completions with the system message first", async () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-test";
    const calls = stubFetch({
      choices: [{ message: { content: "ok" } }],
      model: "gpt-test",
      usage: { prompt_tokens: 7, completion_tokens: 1 },
    });

    const out = await new OpenAIModelProvider("sk-test", "https://api.test/v1").complete({
      prompt: "ping",
      system: "You are terse.",
    });

    assert.equal(out.text, "ok");
    assert.equal(out.model, "gpt-test");
    assert.deepEqual(out.usage, { promptTokens: 7, completionTokens: 1 });
    assert.equal(calls[0]!.url, "https://api.test/v1/chat/completions");
    const sent = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(sent.messages, [
      { role: "system", content: "You are terse." },
      { role: "user", content: "ping" },
    ]);
  });

  it("raises the status on a non-2xx", async () => {
    clearEnv();
    stubFetch({ error: "bad" }, 429);
    await assert.rejects(new OpenAIModelProvider("sk-test").complete({ prompt: "…" }), /openai_429/);
  });
});

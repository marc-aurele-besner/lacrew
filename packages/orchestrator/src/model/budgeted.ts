/**
 * The one place a cost budget is enforced (PRD F2.28).
 *
 * A `ModelProvider` that checks before the call and meters after it, wrapping
 * whichever vendor client is configured. It sits here — at the interface every
 * completion in this process passes through — rather than inside one vendor's
 * client, because a budget that only bound Anthropic calls would be silently
 * bypassed by switching `LACREW_MODEL_PROVIDER`, and because a new provider
 * should not have to remember to opt in to being counted.
 *
 * Ordering is deliberate:
 *
 *   1. **Check first.** A refusal must happen before the request goes out, or
 *      the money is already spent and the "limit" is a report.
 *   2. **Meter after, even when the call threw.** Nothing is charged for a
 *      request that failed to reach the provider — but a provider that returned
 *      an error *after* consuming input tokens has been paid, so a result that
 *      carries usage is recorded whatever else happened to it.
 *
 * The check is a read of a stored counter, so it costs one indexed lookup per
 * completion against a call that takes hundreds of milliseconds.
 */

import { parseModelPrices, priceCompletion, type ModelPrice } from "@lacrew/flows";
import type { BudgetSubject, InferenceBudgetsSurface } from "../inferenceBudgets.js";
import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./types.js";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Who this completion is for, as the caller declared it in `meta`. */
export function subjectOfInput(input: ModelCompleteInput): BudgetSubject {
  const meta = input.meta ?? {};
  return {
    ...(asString(meta.crewId) ? { crewId: asString(meta.crewId) } : {}),
    ...(asString(meta.agentId) ? { agentId: asString(meta.agentId) } : {}),
  };
}

/**
 * Operator price overrides, read once.
 *
 * Read at construction rather than per call so a malformed table is reported
 * once at boot instead of being re-parsed under every completion. A table that
 * does not parse falls back to the shipped defaults *whole* — see
 * `parseModelPrices` for why a partial override is the worse outcome.
 */
export function modelPricesFromEnv(
  json = process.env.LACREW_MODEL_PRICES,
): Record<string, ModelPrice> | undefined {
  const raw = (json ?? "").trim();
  if (!raw) return undefined;
  const parsed = parseModelPrices(raw);
  if (!parsed) {
    console.error(
      "[@lacrew/orchestrator] LACREW_MODEL_PRICES is not a valid " +
        '{"<model-prefix>":{"inputPerMTok":n,"outputPerMTok":n}} table; using built-in prices',
    );
    return undefined;
  }
  return parsed;
}

export function withInferenceBudget(
  provider: ModelProvider,
  budgets: InferenceBudgetsSurface,
  opts: { prices?: Record<string, ModelPrice> } = {},
): ModelProvider {
  const prices = opts.prices ?? modelPricesFromEnv();

  return {
    name: provider.name,
    async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
      const subject = subjectOfInput(input);
      await budgets.check(subject);

      // Past the warn line the crew's declared cheaper model takes over. This
      // is the only place the requested model is substituted, and it never
      // widens anything: a cheaper model has the same tools and the same
      // policy stack, it just costs less to keep the crew alive near the cap.
      const model = await budgets.modelFor(subject, input.model);

      const meta = input.meta ?? {};
      const record = async (result: ModelCompleteResult, promptText?: string) => {
        const priced = priceCompletion({
          model: result.model,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.usage?.costUsd !== undefined ? { usd: result.usage.costUsd } : {}),
          ...(promptText ? { promptText } : {}),
          completionText: result.text,
          ...(prices ? { prices } : {}),
        });
        await budgets.record(subject, {
          ...priced,
          provider: provider.name,
          ...(asString(meta.runId) ? { runId: asString(meta.runId)! } : {}),
          ...(asString(meta.flowId) ? { flowId: asString(meta.flowId)! } : {}),
        });
      };

      const promptText = `${input.system ?? ""}${input.prompt}`;
      // A throw propagates unmetered: a request that never reached the provider
      // costs nothing, and charging for it would make a flapping network read
      // as runaway spend.
      const result = await provider.complete({ ...input, ...(model ? { model } : {}) });

      // A metering failure must not be reported to the caller as a model
      // failure — the completion happened and the caller is holding it. It is
      // logged loudly instead, because a period of unmetered calls is the one
      // thing that makes the enforced number wrong.
      await record(result, promptText).catch((err) => {
        console.error("[@lacrew/orchestrator] inference usage not recorded:", err);
      });

      return result;
    },
  };
}

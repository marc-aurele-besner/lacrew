/**
 * The CLI's one door to a running orchestrator: where it is (`--url`,
 * `ORCH_URL`, the local default), how a request is dressed (JSON when it has a
 * body, the bearer from `ORCH_TOKEN`), and how a refusal is reported.
 *
 * One module rather than a copy per command, so a change to bearer handling
 * or to what a refusal reads like lands everywhere at once.
 */

import { flagValue } from "./args.js";

export const DEFAULT_ORCH_URL = "http://127.0.0.1:8788";

export function orchUrl(args: string[]): string {
  return (flagValue(args, "--url") ?? process.env.ORCH_URL ?? DEFAULT_ORCH_URL).replace(/\/$/, "");
}

/** The headers every orchestrator request carries; `init.headers` wins on conflict. */
export function orchHeaders(
  init: RequestInit = {},
  opts: { json?: boolean } = {},
): Record<string, string> {
  const token = process.env.ORCH_TOKEN?.trim();
  return {
    ...((opts.json ?? Boolean(init.body)) ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
}

/**
 * A non-2xx answer, with the status and the body the orchestrator sent so a
 * caller can act on `body.error` rather than on the message text.
 */
export class OrchRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    statusText = "",
  ) {
    super(refusalMessage(status, body, statusText));
  }
}

function refusalMessage(status: number, body: Record<string, unknown>, statusText: string): string {
  const head =
    typeof body.error === "string" && body.error
      ? body.error
      : `${status}${statusText ? ` ${statusText}` : ""}`;
  // Validation answers carry a list of what was wrong; print it under the head
  // rather than leaving the operator with a one-word error and a guess.
  const errors = Array.isArray(body.errors)
    ? (body.errors as unknown[]).filter((e): e is string => typeof e === "string")
    : [];
  return errors.length ? `${head}\n  ${errors.join("\n  ")}` : head;
}

/** Fetch JSON from the orchestrator; a non-2xx answer throws `OrchRefusal`. */
export async function orchFetch<T>(
  args: string[],
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${orchUrl(args)}${path}`, { ...init, headers: orchHeaders(init) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new OrchRefusal(res.status, body, res.statusText);
  return body as T;
}

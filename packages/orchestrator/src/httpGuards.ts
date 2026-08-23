/**
 * Request guards shared by the live app and the "no chain" app.
 *
 * Browser origin policy is the line between "an operator's orchestrator on
 * localhost" and "a mutation any web page the operator visits can make". Two
 * things hold that line:
 *
 * - **No wildcard CORS.** A response only carries `access-control-allow-origin`
 *   for an origin named in `LACREW_ORCH_CORS_ORIGINS`; unset means no browser
 *   origin may read a response or pass a preflight. The CLI, the SDK and the
 *   cloud control plane are not browsers and are unaffected.
 * - **Mutations are JSON.** A `POST`/`PUT`/`PATCH`/`DELETE` that carries a body
 *   must say `content-type: application/json`. A cross-site form or a
 *   `fetch` with a text body is a "simple request" the browser sends without a
 *   preflight; demanding a JSON content type turns it into one that needs the
 *   preflight above, which the wildcard used to grant and now nothing does.
 *   `POST /hooks/:id` is exempt: producers authenticate by HMAC and some send
 *   other content types.
 */

import type { Context } from "hono";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Comma-separated origin allowlist from the environment. */
export function parseCorsOrigins(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const origin = part.trim().replace(/\/+$/, "");
    if (!origin) continue;
    out.add(origin.toLowerCase());
  }
  return out;
}

/** CORS response headers for this request, or none when its origin is not allowed. */
export function corsHeadersFor(
  origin: string | undefined,
  allowed: ReadonlySet<string>,
): Record<string, string> {
  if (!origin || !allowed.has(origin.toLowerCase())) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "origin",
  };
}

export const CORS_PREFLIGHT_HEADERS = {
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-max-age": "600",
} as const;

/** Whether a content-type header names JSON (with or without parameters). */
export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const media = value.split(";")[0]!.trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
}

/** Whether this mutating request carries a body that is not declared as JSON. */
export function rejectsNonJsonBody(c: Context): boolean {
  if (!MUTATING.has(c.req.method)) return false;
  if (c.req.path.startsWith("/hooks/")) return false;
  const length = c.req.header("content-length");
  const chunked = Boolean(c.req.header("transfer-encoding"));
  // Over the wire a body always declares itself one way or the other; an
  // in-process Request (tests, embedded use) may carry a stream with neither.
  const hasBody =
    chunked ||
    (length !== undefined && length !== "0") ||
    (length === undefined && c.req.raw.body !== null);
  if (!hasBody) return false;
  return !isJsonContentType(c.req.header("content-type"));
}

/**
 * Read a request body up to `limit` bytes, or `null` once it exceeds them — the
 * chunked/undeclared case a `content-length` pre-check cannot cover. Counting
 * on the stream means an oversized body is refused at the limit rather than
 * after it has all been buffered.
 */
export async function readBodyBounded(req: Request, limit: number): Promise<string | null> {
  if (!req.body) {
    const text = await req.text().catch(() => "");
    return Buffer.byteLength(text) > limit ? null : text;
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(value);
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A page size from a query string: the default when absent or unparsable, never
 * below one, never above `max`. An unbounded or negative limit reaches the store
 * as a full-table read or a SQL error otherwise.
 */
export function clampLimit(raw: string | undefined, dflt: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** `BigInt(value)` as a result rather than a thrown SyntaxError that becomes a 500. */
export function parseBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) return null;
  return BigInt(value.trim());
}

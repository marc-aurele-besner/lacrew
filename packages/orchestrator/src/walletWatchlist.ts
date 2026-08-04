/**
 * The wallet watchlist: which chains and tokens agent balances are read on.
 *
 * Two callers, one shape. A self-hoster sets `WALLET_WATCHLIST` to a JSON
 * array; the cloud pushes the same array to `POST /wallets/watchlist`. Both go
 * through `parseWatchlist`, so a malformed entry is refused in exactly one
 * place rather than reaching a chain read as `undefined`.
 *
 * Validation is strict on purpose. A token address that is one character short
 * does not fail loudly at read time — `balanceOf` on a non-contract returns
 * nothing and the UI shows a zero. A zero the operator believes is a real
 * balance is the worst outcome this surface has, so the address never gets that
 * far.
 */

import type { WatchedChain, WatchedToken } from "@lacrew/core";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type ParseResult = { ok: true; value: WatchedChain[] } | { ok: false; error: string };

function parseToken(raw: unknown, chainId: number): WatchedToken | string {
  if (typeof raw !== "object" || raw === null) return `chain ${chainId}: token must be an object`;
  const t = raw as Record<string, unknown>;
  const symbol = typeof t.symbol === "string" ? t.symbol.trim() : "";
  if (!symbol) return `chain ${chainId}: token needs a symbol`;
  if (typeof t.address !== "string" || !ADDRESS.test(t.address)) {
    return `chain ${chainId}: ${symbol} address is not a 20-byte hex address`;
  }
  const decimals = Number(t.decimals);
  // 0 decimals is legitimate (some tokens use it); a missing or absurd value is
  // not, and guessing 18 would misplace the decimal point by orders of magnitude.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return `chain ${chainId}: ${symbol} needs integer decimals between 0 and 36`;
  }
  return { symbol, address: t.address as `0x${string}`, decimals };
}

/** Parse and validate a watchlist from JSON of unknown provenance. */
export function parseWatchlist(raw: unknown): ParseResult {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "watchlist must be an array" };

  const seen = new Set<number>();
  const value: WatchedChain[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "each watchlist entry must be an object" };
    }
    const e = entry as Record<string, unknown>;
    const chainId = Number(e.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      return { ok: false, error: `invalid chainId: ${String(e.chainId)}` };
    }
    // Two entries for one chain would read it twice and render it twice, with
    // no rule for which token list wins.
    if (seen.has(chainId)) return { ok: false, error: `chain ${chainId} listed twice` };
    seen.add(chainId);

    const rpcUrl = typeof e.rpcUrl === "string" ? e.rpcUrl.trim() : "";
    if (rpcUrl && !/^https?:\/\//i.test(rpcUrl)) {
      return { ok: false, error: `chain ${chainId}: rpcUrl must be http(s)` };
    }

    const tokens: WatchedToken[] = [];
    const rawTokens = Array.isArray(e.tokens) ? e.tokens : [];
    const addresses = new Set<string>();
    for (const rawToken of rawTokens) {
      const token = parseToken(rawToken, chainId);
      if (typeof token === "string") return { ok: false, error: token };
      // The same contract twice would show one balance as two holdings and
      // double it in any total summed from the rows.
      if (addresses.has(token.address.toLowerCase())) {
        return { ok: false, error: `chain ${chainId}: ${token.address} listed twice` };
      }
      addresses.add(token.address.toLowerCase());
      tokens.push(token);
    }

    value.push({ chainId, ...(rpcUrl ? { rpcUrl } : {}), tokens });
  }

  return { ok: true, value };
}

/** Read the self-host watchlist from the environment; [] when unset or bad. */
export function watchlistFromEnv(raw = process.env.WALLET_WATCHLIST): WatchedChain[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = parseWatchlist(JSON.parse(raw));
    if (parsed.ok) return parsed.value;
    console.warn(`[lacrew] WALLET_WATCHLIST ignored: ${parsed.error}`);
  } catch {
    console.warn("[lacrew] WALLET_WATCHLIST ignored: not valid JSON");
  }
  return [];
}

/**
 * An RPC URL with its credentials removed, for display and logs.
 *
 * Provider keys ride in the path (`/v2/<key>`) or the query string, and this
 * value is echoed by a GET route and can end up in a log line. The host is what
 * an operator needs to recognise the endpoint; the key is not.
 */
export function maskRpcUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const path = segments.length > 0 ? `/${segments[0]}/…` : "";
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return "…";
  }
}

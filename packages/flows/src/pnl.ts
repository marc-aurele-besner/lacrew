/**
 * Unified seat / crew P&L (F2.33) — the pure half.
 *
 * One period report per crew (and per seat) that puts three meters an operator
 * currently reads in three places on one page: what left the treasury onchain,
 * what the crew's model calls cost, and what its connectors did to the outside
 * world. Nothing here reaches a chain, a database or a provider — it folds rows
 * somebody else read into totals, so a CLI, an orchestrator and a control plane
 * can all produce the same figures from the same inputs.
 *
 * Three rules the shapes here exist to enforce:
 *
 *   - **This is reporting, not authority.** No function in this file approves,
 *     refuses, revokes or moves anything. A P&L that could act would be a second
 *     enforcement path for money, and the protocol already has exactly one.
 *   - **Honesty over completeness.** A call nobody can price is `unpriced`, never
 *     $0, and every `$` figure carries the count of calls it omits. A meter that
 *     is not wired reports `available: false`, which is not the same claim as a
 *     zero. Onchain amounts stay in the asset's own base units — converting USDC
 *     to "dollars" is safe, converting WETH is a price feed this does not have.
 *   - **A total that cannot be reconciled says so.** Seat rows sum to the crew
 *     total, or the difference is named (`unattributed`) rather than quietly
 *     absorbed into a seat that did not incur it.
 */

import type {
  InferenceBudgetStatus,
  InferenceUsage,
} from "./inferenceBudget.js";

/* ------------------------------------------------------------------ period */

export const PNL_PERIOD_KINDS = [
  "calendar_month",
  "calendar_week",
  "epoch",
  "custom",
] as const;

export type PnlPeriodKind = (typeof PNL_PERIOD_KINDS)[number];

export type PnlPeriod = {
  kind: PnlPeriodKind;
  /** Stable label for the window: `2026-07`, `2026-W31`, `epoch:604800:2718`. */
  key: string;
  /** Inclusive. */
  from: string;
  /** Exclusive — so two adjacent periods never double-count a boundary row. */
  to: string;
  /**
   * Always UTC. A workspace timezone would move month boundaries, and a figure
   * that changes with the reader's timezone is not a figure an accountant can
   * check. Stated on the payload rather than assumed by the reader.
   */
  timezone: "UTC";
};

/** A report may not span more than this; a wider window is operator error. */
export const PNL_MAX_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;

/** Default epoch length when the deployment's cadence is unknown. */
const EPOCH_SECONDS_DEFAULT = 7 * 86_400;

const EPOCH_ANCHOR_DEFAULT = "1970-01-01T00:00:00.000Z";

export type PnlPeriodInput = {
  period?: string;
  /** Inclusive ISO instant; with `to`, forces a custom period. */
  from?: string;
  /** Exclusive ISO instant. */
  to?: string;
  /** Length of the deployment's epoch, for `period=epoch`. */
  epochSeconds?: number;
  /** Where epochs are counted from, for `period=epoch`. */
  epochAnchorAt?: string;
};

function isoWeekKey(d: Date): string {
  // ISO-8601 week: Thursday of the current week decides the year.
  const thursday = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3,
    ),
  );
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      (thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS) -
        ((firstThursday.getUTCDay() + 6) % 7) / 7,
    );
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The window a report covers.
 *
 * `from`/`to` win over `period`, because an explicit range is the operator
 * asking for exactly those instants. Anything unparseable throws rather than
 * silently falling back to "this month" — a report labelled with a period it
 * did not measure is the failure this whole feature exists to avoid.
 */
export function resolvePnlPeriod(input: PnlPeriodInput, now: Date): PnlPeriod {
  if (input.from || input.to) {
    const fromMs = Date.parse(input.from ?? "");
    const toMs = input.to ? Date.parse(input.to) : now.getTime();
    if (!Number.isFinite(fromMs)) throw new Error("invalid_from");
    if (!Number.isFinite(toMs)) throw new Error("invalid_to");
    if (toMs <= fromMs) throw new Error("empty_period");
    if (toMs - fromMs > PNL_MAX_RANGE_DAYS * DAY_MS)
      throw new Error("period_too_long");
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    return { kind: "custom", key: `${from}/${to}`, from, to, timezone: "UTC" };
  }

  const period = (input.period ?? "calendar_month") as PnlPeriodKind;
  if (period === "calendar_month") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    return {
      kind: period,
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
      from: start.toISOString(),
      to: end.toISOString(),
      timezone: "UTC",
    };
  }
  if (period === "calendar_week") {
    // Monday-anchored, matching ISO-8601 — the week an accountant means.
    const dayOffset = (now.getUTCDay() + 6) % 7;
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - dayOffset,
      ),
    );
    const end = new Date(start.getTime() + 7 * DAY_MS);
    return {
      kind: period,
      key: isoWeekKey(start),
      from: start.toISOString(),
      to: end.toISOString(),
      timezone: "UTC",
    };
  }
  if (period === "epoch") {
    const lengthMs =
      Math.max(1, input.epochSeconds ?? EPOCH_SECONDS_DEFAULT) * 1_000;
    const anchor = Date.parse(input.epochAnchorAt ?? EPOCH_ANCHOR_DEFAULT);
    if (!Number.isFinite(anchor)) throw new Error("invalid_epoch_anchor");
    const index = Math.floor((now.getTime() - anchor) / lengthMs);
    const start = anchor + index * lengthMs;
    return {
      kind: period,
      key: `epoch:${lengthMs}:${index}`,
      from: new Date(start).toISOString(),
      to: new Date(start + lengthMs).toISOString(),
      timezone: "UTC",
    };
  }
  throw new Error("invalid_period");
}

/* ----------------------------------------------------------------- sources */

/**
 * Where one meter's figures came from, and how far they can be trusted.
 *
 * `available: false` is not a zero: it means nothing answered for this meter,
 * and the operator is being told so instead of being shown an invented total.
 * `complete: false` means the window was answered from something bounded (an
 * in-memory ring), the same discipline `/usage` applies to billing counts.
 */
export type PnlSource = {
  available: boolean;
  complete: boolean;
  /** The store that answered, or `none`. */
  store: string;
  note?: string;
};

export const PNL_SOURCE_UNAVAILABLE: PnlSource = {
  available: false,
  complete: false,
  store: "none",
};

export type PnlSources = {
  /** Chain-derived rows: spends, escalations, epoch grants. */
  onchain: PnlSource;
  /** Inference metering (F2.28 counters). */
  inference: PnlSource;
  /** Connector `ToolCalled` rows on the audit trail. */
  connectors: PnlSource;
};

/* ------------------------------------------------------------------ onchain */

export type PnlAuditEvent = {
  type: string;
  at: string;
  payload: Record<string, unknown>;
};

export type PnlSpendRow = {
  at: string;
  agent: string;
  target: string;
  /** Base units of `asset`, as a decimal string. Never a float. */
  value: string;
  asset: string;
  txHash?: string;
  intentId?: string;
  /**
   * Present and false when the executed call itself reverted. The value still
   * left, so the row stays in the total — but a reader deciding what the crew
   * achieved needs to know the call did not land.
   */
  callOk?: boolean;
};

export type PnlPendingRow = {
  at: string;
  agent: string;
  target: string;
  value: string;
  asset: string;
  intentId: string;
  awaitingApprover?: string;
};

export type PnlGrantRow = {
  at: string;
  node: string;
  amount: string;
  asset: string;
  epoch?: string;
  txHash?: string;
};

export type PnlMarketplaceRow = {
  at: string;
  agent: string;
  catalogId: string;
  gross: string;
  fee?: string;
  asset: string;
  txHash?: string;
};

/** Per-asset totals, in that asset's own base units. */
export type PnlAssetTotal = {
  asset: string;
  spent: string;
  pending: string;
  granted: string;
  marketplace: string;
};

export type PnlOnchain = {
  assets: PnlAssetTotal[];
  spends: PnlSpendRow[];
  pending: PnlPendingRow[];
  grants: PnlGrantRow[];
  marketplace: PnlMarketplaceRow[];
  counts: {
    spends: number;
    pending: number;
    grants: number;
    marketplace: number;
  };
};

/* ---------------------------------------------------------------- inference */

export type PnlUsageRow = {
  scopeKey: string;
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  /** Null when the call could not be priced — never stored or summed as zero. */
  usdMicros: number | null;
  priceSource: string;
  runId?: string;
  flowId?: string;
  at: string;
};

export type PnlInferenceBreakdown = {
  key: string;
  calls: number;
  usdMicros: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
};

export type PnlInference = InferenceUsage & {
  /** Top spenders by cost, for the drawer. */
  byFlow: PnlInferenceBreakdown[];
  byModel: PnlInferenceBreakdown[];
};

export const ZERO_PNL_INFERENCE: PnlInference = {
  inputTokens: 0,
  outputTokens: 0,
  usdMicros: 0,
  calls: 0,
  unpricedCalls: 0,
  byFlow: [],
  byModel: [],
};

/* --------------------------------------------------------------- connectors */

export type PnlConnectorRoute = {
  connector: string;
  route: string;
  effect: "read" | "write" | "unknown";
  calls: number;
  failed: number;
  /** Null when no price is configured for this route — never 0. */
  usdMicros: number | null;
};

export type PnlConnectors = {
  calls: number;
  reads: number;
  writes: number;
  failed: number;
  routes: PnlConnectorRoute[];
  /** Sum over priced routes only; null when nothing here has a price. */
  usdMicros: number | null;
  pricedCalls: number;
  unpricedCalls: number;
};

export const ZERO_PNL_CONNECTORS: PnlConnectors = {
  calls: 0,
  reads: 0,
  writes: 0,
  failed: 0,
  routes: [],
  usdMicros: null,
  pricedCalls: 0,
  unpricedCalls: 0,
};

/**
 * Operator-supplied price per connector call, in USD.
 *
 * Keyed `<connector>.<route>` or `<connector>` for a whole connector; the
 * narrower key wins. Nothing ships pre-priced: LaCrew does not know what a
 * workspace pays its SaaS vendors, and a guessed number in a P&L is worse than
 * an honest blank.
 */
export type ConnectorPrices = Record<string, number>;

export function parseConnectorPrices(
  json: string | undefined,
): ConnectorPrices | null {
  if (!json?.trim()) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const out: ConnectorPrices = {};
    for (const [key, value] of Object.entries(parsed)) {
      const usd = typeof value === "number" ? value : Number(value);
      // A negative or non-finite price is a typo, and a typo that lands in a
      // cost report reads as a discount nobody negotiated.
      if (Number.isFinite(usd) && usd >= 0) out[key.trim().toLowerCase()] = usd;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** USD per call for one route, or null when the table does not price it. */
export function lookupConnectorPrice(
  prices: ConnectorPrices | null | undefined,
  connector: string,
  route: string,
): number | null {
  if (!prices) return null;
  const exact = prices[`${connector}.${route}`.toLowerCase()];
  if (exact !== undefined) return exact;
  const whole = prices[connector.toLowerCase()];
  return whole !== undefined ? whole : null;
}

/* ------------------------------------------------------------------ report */

export type PnlSeat = {
  agentId: string;
  label?: string;
  onchain: PnlOnchain;
  inference: PnlInference;
  connectors: PnlConnectors;
};

/**
 * Room left against the two ceilings this report sits between — deliberately
 * two, because they bound different things and neither substitutes for the
 * other. Onchain remaining is a Treasury allowance; inference remaining is a
 * cost budget the runtime enforces at the model provider.
 */
export type PnlHeadroom = {
  onchain: Array<{
    node: string;
    asset: string;
    /** Allowance left in the Treasury, base units. Null when unread. */
    remaining: string | null;
    /** SpendCapPolicy per-call ceiling, base units. Null when not enforced. */
    capPerCall: string | null;
  }>;
  inference: {
    scopeKey: string;
    /** The budget's own period key — not necessarily this report's. */
    periodKey: string;
    /** False when the budget's window and the report's window differ. */
    periodMatchesReport: boolean;
    policy: string;
    status: InferenceBudgetStatus;
    limitUsdMicros: number | null;
    remainingUsdMicros: number | null;
  } | null;
};

export type PnlReport = {
  scope: { kind: "crew" | "agent"; crewId: string; agentId?: string };
  period: PnlPeriod;
  /** When the aggregate was computed. Period aggregates are not live. */
  asOf: string;
  totals: {
    onchain: PnlOnchain;
    inference: PnlInference;
    connectors: PnlConnectors;
  };
  seats: PnlSeat[];
  /**
   * The crew total minus the sum of its seats, per meter. Zero when every row
   * named a seat; non-zero when calls were charged to the crew without one, in
   * which case the seat table genuinely does not add up and says so instead of
   * spreading the difference around.
   */
  unattributed: {
    inference: Pick<PnlInference, "calls" | "usdMicros" | "unpricedCalls">;
    connectors: Pick<PnlConnectors, "calls">;
  };
  headroom: PnlHeadroom;
  sources: PnlSources;
  notes: string[];
};

export type PnlBuildInput = {
  scope: { crewId: string; agentId?: string };
  period: PnlPeriod;
  asOf: string;
  /**
   * The crew's own account plus everything reporting to it, in tree order.
   *
   * `usageScopeKey` is the metering scope the seat's calls are charged under
   * when it is not this crew's — a sub-manager's own calls sit under the crew
   * above it. Omitted, this crew's key is assumed.
   */
  seats: Array<{ account: string; label?: string; usageScopeKey?: string }>;
  events: PnlAuditEvent[];
  usage: PnlUsageRow[];
  sources: PnlSources;
  /** Symbol rows are denominated in when a payload names no asset. */
  primaryAsset?: string;
  allowances?: Array<{
    node: string;
    asset: string;
    balance: string | null;
    cap: string | null;
  }>;
  budget?: {
    scopeKey: string;
    periodKey: string;
    periodFrom: string;
    periodTo: string;
    policy: string;
    status: InferenceBudgetStatus;
    limitUsd?: number;
  } | null;
  connectorPrices?: ConnectorPrices | null;
  /** Cap on the detail rows carried in each breakdown. */
  rowLimit?: number;
};

const DEFAULT_ROW_LIMIT = 25;

const norm = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const bigOr0 = (value: unknown): bigint => {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
};

const str = (value: unknown): string | undefined => {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : undefined;
};

function emptyOnchain(): PnlOnchain {
  return {
    assets: [],
    spends: [],
    pending: [],
    grants: [],
    marketplace: [],
    counts: { spends: 0, pending: 0, grants: 0, marketplace: 0 },
  };
}

/**
 * Fold one seat's (or one crew's) rows into the three meters.
 *
 * `seatFilter` is null for the crew total, which is the whole point of the
 * split: the crew total counts every row attributed to the crew, including the
 * ones no seat claimed, so the difference between it and the seat sum is a real
 * number rather than an artefact of double counting.
 */
function foldOnchain(
  events: PnlAuditEvent[],
  opts: { primaryAsset: string; rowLimit: number },
): PnlOnchain {
  const out = emptyOnchain();
  type AssetTotals = {
    spent: bigint;
    pending: bigint;
    granted: bigint;
    marketplace: bigint;
  };
  const totals = new Map<string, AssetTotals>();
  const bump = (asset: string, field: keyof AssetTotals, amount: bigint) => {
    const row = totals.get(asset) ?? {
      spent: 0n,
      pending: 0n,
      granted: 0n,
      marketplace: 0n,
    };
    row[field] += amount;
    totals.set(asset, row);
  };

  // A marketplace purchase settles through the same router as any other spend,
  // so its txHash also appears as an ActionExecuted. Counted once, under the
  // line that names what it bought.
  const marketplaceTx = new Set<string>();
  for (const e of events) {
    if (e.type === "MarketplacePurchase") {
      const tx = str(e.payload.txHash);
      if (tx) marketplaceTx.add(tx.toLowerCase());
    }
  }

  // Escalations are pending unless their resolution is in the same window. An
  // intent resolved after the period ended was genuinely pending at the close,
  // which is what a period report is supposed to say.
  const resolved = new Set<string>();
  for (const e of events) {
    if (e.type === "IntentResolved") {
      const id = str(e.payload.intentId);
      if (id) resolved.add(id);
    }
  }

  const spendSeen = new Set<string>();
  for (const e of events) {
    const asset = str(e.payload.asset) ?? opts.primaryAsset;
    const txHash = str(e.payload.txHash);

    if (e.type === "AllowanceSpent" || e.type === "ActionExecuted") {
      if (txHash && marketplaceTx.has(txHash.toLowerCase())) continue;
      // The same settled action is announced twice — once locally at propose
      // time, once from the receipt. One spend, one row.
      const key = txHash
        ? `tx:${txHash.toLowerCase()}`
        : `${norm(e.payload.agent)}:${String(e.payload.value)}:${e.at}`;
      if (spendSeen.has(key)) continue;
      spendSeen.add(key);
      const value = bigOr0(e.payload.value);
      out.spends.push({
        at: e.at,
        agent: norm(e.payload.agent),
        target: norm(e.payload.target),
        value: value.toString(),
        asset,
        ...(txHash ? { txHash } : {}),
        ...(str(e.payload.intentId)
          ? { intentId: str(e.payload.intentId)! }
          : {}),
        ...(e.payload.callOk === false ? { callOk: false } : {}),
      });
      bump(asset, "spent", value);
      continue;
    }

    if (e.type === "IntentCreated") {
      const intentId = str(e.payload.intentId);
      if (!intentId || resolved.has(intentId)) continue;
      const value = bigOr0(e.payload.value);
      out.pending.push({
        at: e.at,
        agent: norm(e.payload.agent),
        target: norm(e.payload.target),
        value: value.toString(),
        asset,
        intentId,
        ...(str(e.payload.awaitingApprover)
          ? { awaitingApprover: norm(e.payload.awaitingApprover) }
          : {}),
      });
      bump(asset, "pending", value);
      continue;
    }

    if (e.type === "AllowanceStreamed") {
      // The runtime also marks the epoch itself, with no node and no amount.
      // That is a schedule tick, not money arriving anywhere.
      if (e.payload.node == null || e.payload.amount == null) continue;
      const amount = bigOr0(e.payload.amount);
      out.grants.push({
        at: e.at,
        node: norm(e.payload.node),
        amount: amount.toString(),
        asset,
        ...(e.payload.epoch != null ? { epoch: String(e.payload.epoch) } : {}),
        ...(txHash ? { txHash } : {}),
      });
      bump(asset, "granted", amount);
      continue;
    }

    if (e.type === "MarketplacePurchase") {
      // A purchase that escalated has not moved anything yet; it is a pending
      // intent like any other and is counted as one, not as a settled cost.
      if (norm(e.payload.verdict) !== "allow") continue;
      const gross = bigOr0(e.payload.gross);
      out.marketplace.push({
        at: e.at,
        agent: norm(e.payload.agent),
        catalogId: str(e.payload.catalogId) ?? "",
        gross: gross.toString(),
        ...(e.payload.fee != null
          ? { fee: bigOr0(e.payload.fee).toString() }
          : {}),
        asset,
        ...(txHash ? { txHash } : {}),
      });
      bump(asset, "marketplace", gross);
    }
  }

  out.counts = {
    spends: out.spends.length,
    pending: out.pending.length,
    grants: out.grants.length,
    marketplace: out.marketplace.length,
  };
  const byValueDesc = <
    T extends { value?: string; amount?: string; gross?: string },
  >(
    a: T,
    b: T,
  ) => {
    const av = bigOr0(a.value ?? a.amount ?? a.gross);
    const bv = bigOr0(b.value ?? b.amount ?? b.gross);
    return av === bv ? 0 : av > bv ? -1 : 1;
  };
  out.spends = out.spends.sort(byValueDesc).slice(0, opts.rowLimit);
  out.pending = out.pending.sort(byValueDesc).slice(0, opts.rowLimit);
  out.grants = out.grants.sort(byValueDesc).slice(0, opts.rowLimit);
  out.marketplace = out.marketplace.sort(byValueDesc).slice(0, opts.rowLimit);
  out.assets = [...totals.entries()]
    .map(([asset, row]) => ({
      asset,
      spent: row.spent.toString(),
      pending: row.pending.toString(),
      granted: row.granted.toString(),
      marketplace: row.marketplace.toString(),
    }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
  return out;
}

function foldInference(rows: PnlUsageRow[], rowLimit: number): PnlInference {
  const out: PnlInference = { ...ZERO_PNL_INFERENCE, byFlow: [], byModel: [] };
  const byFlow = new Map<string, PnlInferenceBreakdown>();
  const byModel = new Map<string, PnlInferenceBreakdown>();
  const into = (
    map: Map<string, PnlInferenceBreakdown>,
    key: string,
    row: PnlUsageRow,
  ) => {
    const entry = map.get(key) ?? {
      key,
      calls: 0,
      usdMicros: 0,
      unpricedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    entry.calls += 1;
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens;
    if (row.usdMicros === null) entry.unpricedCalls += 1;
    else entry.usdMicros += row.usdMicros;
    map.set(key, entry);
  };

  for (const row of rows) {
    out.calls += 1;
    out.inputTokens += row.inputTokens;
    out.outputTokens += row.outputTokens;
    // An unpriced call is counted, never summed as zero: its tokens are real
    // and the reader is told how many dollars the figure is missing.
    if (row.usdMicros === null) out.unpricedCalls += 1;
    else out.usdMicros += row.usdMicros;
    into(byFlow, row.flowId ?? row.runId ?? "ad-hoc", row);
    into(byModel, row.model || "unknown", row);
  }

  const top = (map: Map<string, PnlInferenceBreakdown>) =>
    [...map.values()]
      .sort((a, b) => b.usdMicros - a.usdMicros || b.calls - a.calls)
      .slice(0, rowLimit);
  out.byFlow = top(byFlow);
  out.byModel = top(byModel);
  return out;
}

function foldConnectors(
  events: PnlAuditEvent[],
  prices: ConnectorPrices | null | undefined,
  rowLimit: number,
): PnlConnectors {
  const out: PnlConnectors = { ...ZERO_PNL_CONNECTORS, routes: [] };
  const routes = new Map<string, PnlConnectorRoute>();
  let pricedMicros = 0;
  let anyPriced = false;

  for (const e of events) {
    if (e.type !== "ToolCalled") continue;
    const connector = str(e.payload.connector) ?? "unknown";
    const route = str(e.payload.route) ?? "unknown";
    const rawEffect = norm(e.payload.effect);
    const effect: PnlConnectorRoute["effect"] =
      rawEffect === "write"
        ? "write"
        : rawEffect === "read"
          ? "read"
          : "unknown";
    const ok = e.payload.ok !== false;
    const key = `${connector}.${route}`;
    const usd = lookupConnectorPrice(prices, connector, route);
    const entry = routes.get(key) ?? {
      connector,
      route,
      effect,
      calls: 0,
      failed: 0,
      usdMicros: usd === null ? null : 0,
    };
    entry.calls += 1;
    if (!ok) entry.failed += 1;
    if (usd !== null) {
      entry.usdMicros = (entry.usdMicros ?? 0) + Math.round(usd * 1_000_000);
      pricedMicros += Math.round(usd * 1_000_000);
      anyPriced = true;
      out.pricedCalls += 1;
    } else {
      out.unpricedCalls += 1;
    }
    routes.set(key, entry);

    out.calls += 1;
    if (effect === "write") out.writes += 1;
    else if (effect === "read") out.reads += 1;
    if (!ok) out.failed += 1;
  }

  out.routes = [...routes.values()]
    .sort(
      (a, b) => (b.usdMicros ?? 0) - (a.usdMicros ?? 0) || b.calls - a.calls,
    )
    .slice(0, rowLimit);
  // Null rather than 0 when nothing here is priced: "$0.00 of connector spend"
  // is a claim about the vendor's invoice this report has no way to make.
  out.usdMicros = anyPriced ? pricedMicros : null;
  return out;
}

/** Events whose subject is one of `accounts` (empty set → everything). */
function eventsForAccounts(
  events: PnlAuditEvent[],
  accounts: Set<string> | null,
): PnlAuditEvent[] {
  if (!accounts) return events;
  return events.filter((e) => {
    const subject =
      norm(e.payload.agent) ||
      norm(e.payload.node) ||
      norm(e.payload.buyer) ||
      norm(e.payload.agentId);
    return subject ? accounts.has(subject) : false;
  });
}

/**
 * The crew's rows: everything a seat under it did, plus everything the crew was
 * charged for directly. A `ToolCalled` names its crew, so a connector call made
 * by a flow run stays in the crew total even when the run named no seat.
 */
function crewEvents(
  events: PnlAuditEvent[],
  crewId: string,
  seats: Set<string>,
): PnlAuditEvent[] {
  return events.filter((e) => {
    // A resolution names the intent, not the agent, so it has no subject to
    // match on. Kept regardless: it is what closes an escalation, and dropping
    // it would leave decided intents sitting in "pending" forever.
    if (e.type === "IntentResolved") return true;
    if (e.type === "ToolCalled") {
      const eventCrew = norm(e.payload.crewId);
      if (eventCrew) return eventCrew === crewId;
      const agent = norm(e.payload.agentId);
      return agent ? seats.has(agent) : false;
    }
    const subject =
      norm(e.payload.agent) || norm(e.payload.node) || norm(e.payload.buyer);
    return subject ? seats.has(subject) : false;
  });
}

function seatEvents(events: PnlAuditEvent[], seat: string): PnlAuditEvent[] {
  return events.filter((e) => {
    if (e.type === "IntentResolved") return true;
    if (e.type === "ToolCalled") return norm(e.payload.agentId) === seat;
    const subject =
      norm(e.payload.agent) || norm(e.payload.node) || norm(e.payload.buyer);
    return subject === seat;
  });
}

/**
 * Usage rows for a scope key. The runtime writes one row per scope a call is
 * charged to — `crew:<id>` and, when the call named a seat, `crew:<id>/agent:<0x…>`.
 * Reading the crew key gives the crew total; reading a seat key gives that
 * seat's share. Summing both would count every seat call twice, which is why
 * the two are never added together anywhere in this file.
 */
function usageForScope(rows: PnlUsageRow[], scopeKey: string): PnlUsageRow[] {
  return rows.filter((r) => norm(r.scopeKey) === scopeKey);
}

/**
 * The scope key a seat's calls are actually charged under.
 *
 * Usually the crew being reported on, but not always: the runtime charges a
 * call to the seat's *nearest manager*, so a sub-manager's own calls sit under
 * the crew above it while the sub-manager still reports inside this subtree.
 * The caller (which holds the org chart) may say so per seat; without that, the
 * reported crew is assumed.
 */
function seatUsageKey(seat: { account: string; usageScopeKey?: string }, crewKey: string): string {
  return norm(seat.usageScopeKey) || `${crewKey}/agent:${seat.account}`;
}

export function buildPnlReport(input: PnlBuildInput): PnlReport {
  const rowLimit = input.rowLimit ?? DEFAULT_ROW_LIMIT;
  const primaryAsset = input.primaryAsset ?? "USDC";
  const crewId = norm(input.scope.crewId);
  const agentScope = input.scope.agentId
    ? norm(input.scope.agentId)
    : undefined;
  const seatAccounts = input.seats
    .map((s) => ({ ...s, account: norm(s.account) }))
    .filter((s) => s.account);
  const seatSet = new Set(seatAccounts.map((s) => s.account));

  const inRange = input.events.filter((e) => {
    const t = Date.parse(e.at);
    return (
      Number.isFinite(t) &&
      t >= Date.parse(input.period.from) &&
      t < Date.parse(input.period.to)
    );
  });
  const usageInRange = input.usage.filter((r) => {
    const t = Date.parse(r.at);
    return (
      Number.isFinite(t) &&
      t >= Date.parse(input.period.from) &&
      t < Date.parse(input.period.to)
    );
  });

  const scopedEvents = agentScope
    ? seatEvents(inRange, agentScope)
    : crewEvents(inRange, crewId, seatSet);
  const crewUsageKey = `crew:${crewId}`;
  const seatKeys = new Map(
    seatAccounts.map((seat) => [seat.account, seatUsageKey(seat, crewUsageKey)]),
  );
  // The crew's own key, plus the seats charged somewhere else. A seat under
  // this crew's key is already inside that key's rows, so adding it again
  // would count every attributed call twice; a seat charged to a sub-crew (or
  // to the crew above, as a manager's own calls are) is not, and would
  // otherwise be missing from a report on the subtree it sits in.
  const crewUsage = agentScope
    ? usageForScope(usageInRange, seatKeys.get(agentScope) ?? `${crewUsageKey}/agent:${agentScope}`)
    : [
        ...usageForScope(usageInRange, crewUsageKey),
        ...seatAccounts
          .filter((seat) => !seatKeys.get(seat.account)!.startsWith(`${crewUsageKey}/`))
          .flatMap((seat) => usageForScope(usageInRange, seatKeys.get(seat.account)!)),
      ];
  const scopedUsage = crewUsage;

  const totals = {
    onchain: foldOnchain(scopedEvents, { primaryAsset, rowLimit }),
    inference: foldInference(scopedUsage, rowLimit),
    connectors: foldConnectors(scopedEvents, input.connectorPrices, rowLimit),
  };

  // A seat report is one seat; a crew report breaks down into its roster.
  const seatRows = agentScope
    ? []
    : seatAccounts.map((seat) => ({
        agentId: seat.account,
        ...(seat.label ? { label: seat.label } : {}),
        onchain: foldOnchain(seatEvents(inRange, seat.account), {
          primaryAsset,
          rowLimit,
        }),
        inference: foldInference(
          usageForScope(usageInRange, seatKeys.get(seat.account)!),
          rowLimit,
        ),
        connectors: foldConnectors(
          seatEvents(inRange, seat.account),
          input.connectorPrices,
          rowLimit,
        ),
      }));

  const seatInference = seatRows.reduce(
    (acc, s) => ({
      calls: acc.calls + s.inference.calls,
      usdMicros: acc.usdMicros + s.inference.usdMicros,
      unpricedCalls: acc.unpricedCalls + s.inference.unpricedCalls,
    }),
    { calls: 0, usdMicros: 0, unpricedCalls: 0 },
  );
  const seatConnectorCalls = seatRows.reduce(
    (acc, s) => acc + s.connectors.calls,
    0,
  );

  const notes: string[] = [];
  if (!input.sources.onchain.available) {
    notes.push(
      "No chain-derived rows are readable for this period — zeros here are not a claim of zero.",
    );
  } else if (!input.sources.onchain.complete) {
    notes.push(
      "Onchain rows were answered from a bounded ring, so older activity in this period may be missing.",
    );
  }
  if (!input.sources.inference.available) {
    notes.push(
      "Inference metering is not configured (F2.28) — model cost is unmeasured, not zero.",
    );
  } else if (!input.sources.inference.complete) {
    notes.push(
      "Inference rows were answered from a bounded ring, so older calls in this period may be missing.",
    );
  }
  if (totals.inference.unpricedCalls > 0) {
    notes.push(
      `${totals.inference.unpricedCalls} model call(s) had no known price — the inference $ figure is a floor.`,
    );
  }
  if (totals.connectors.calls > 0 && totals.connectors.usdMicros === null) {
    notes.push(
      "No connector price table is configured — connector usage is reported in calls, price unknown.",
    );
  } else if (totals.connectors.unpricedCalls > 0) {
    notes.push(
      `${totals.connectors.unpricedCalls} connector call(s) are unpriced — the connector $ figure covers ${totals.connectors.pricedCalls} call(s).`,
    );
  }
  const unattributedInferenceCalls =
    totals.inference.calls - seatInference.calls;
  if (!agentScope && unattributedInferenceCalls > 0) {
    notes.push(
      `${unattributedInferenceCalls} model call(s) were charged to the crew without naming a seat, so the seat rows do not sum to the crew total.`,
    );
  }
  if (totals.onchain.spends.some((s) => s.callOk === false)) {
    notes.push(
      "At least one settled spend's own call reverted; the value still left the treasury.",
    );
  }

  const headroom: PnlHeadroom = {
    onchain: (input.allowances ?? [])
      .filter((a) =>
        agentScope ? norm(a.node) === agentScope : seatSet.has(norm(a.node)),
      )
      .map((a) => ({
        node: norm(a.node),
        asset: a.asset,
        remaining: a.balance,
        capPerCall: a.cap,
      })),
    inference: input.budget
      ? {
          scopeKey: input.budget.scopeKey,
          periodKey: input.budget.periodKey,
          periodMatchesReport:
            input.budget.periodFrom === input.period.from &&
            input.budget.periodTo === input.period.to,
          policy: input.budget.policy,
          status: input.budget.status,
          limitUsdMicros:
            input.budget.limitUsd === undefined
              ? null
              : Math.round(input.budget.limitUsd * 1_000_000),
          remainingUsdMicros:
            input.budget.limitUsd === undefined
              ? null
              : Math.max(
                  0,
                  Math.round(input.budget.limitUsd * 1_000_000) -
                    input.budget.status.usage.usdMicros,
                ),
        }
      : null,
  };
  if (headroom.inference && !headroom.inference.periodMatchesReport) {
    notes.push(
      `The inference budget runs on ${headroom.inference.periodKey}, a different window than this report — its progress bar is not this period's spend.`,
    );
  }

  return {
    scope: {
      kind: agentScope ? "agent" : "crew",
      crewId,
      ...(agentScope ? { agentId: agentScope } : {}),
    },
    period: input.period,
    asOf: input.asOf,
    totals,
    seats: seatRows,
    unattributed: {
      inference: {
        calls: Math.max(0, unattributedInferenceCalls),
        usdMicros: Math.max(
          0,
          totals.inference.usdMicros - seatInference.usdMicros,
        ),
        unpricedCalls: Math.max(
          0,
          totals.inference.unpricedCalls - seatInference.unpricedCalls,
        ),
      },
      connectors: {
        calls: Math.max(0, totals.connectors.calls - seatConnectorCalls),
      },
    },
    headroom,
    sources: input.sources,
    notes,
  };
}

/* --------------------------------------------------------------------- csv */

const csvCell = (value: unknown): string => {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * One flat CSV an accountant can open, one row per line item.
 *
 * `usd` is left empty rather than zero where nothing could price the row, and
 * `price_known` says which of the two a blank is. A spreadsheet that sums an
 * invented zero is the exact failure this column exists to prevent.
 */
export function pnlToCsv(report: PnlReport): string {
  const rows: string[][] = [
    [
      "scope",
      "seat",
      "meter",
      "unit",
      "quantity",
      "usd",
      "price_known",
      "detail",
    ],
  ];
  const scopeLabel =
    report.scope.kind === "agent" ? report.scope.agentId! : report.scope.crewId;

  const meterRows = (
    seat: string,
    onchain: PnlOnchain,
    inference: PnlInference,
    connectors: PnlConnectors,
  ) => {
    for (const asset of onchain.assets) {
      rows.push([
        scopeLabel,
        seat,
        "onchain_spent",
        asset.asset,
        asset.spent,
        "",
        "n/a",
        "base units",
      ]);
      rows.push([
        scopeLabel,
        seat,
        "onchain_pending",
        asset.asset,
        asset.pending,
        "",
        "n/a",
        "escalations awaiting a decision",
      ]);
      rows.push([
        scopeLabel,
        seat,
        "onchain_granted",
        asset.asset,
        asset.granted,
        "",
        "n/a",
        "epoch allowance streamed in",
      ]);
      if (asset.marketplace !== "0") {
        rows.push([
          scopeLabel,
          seat,
          "marketplace",
          asset.asset,
          asset.marketplace,
          "",
          "n/a",
          "listing purchases",
        ]);
      }
    }
    rows.push([
      scopeLabel,
      seat,
      "inference",
      "calls",
      String(inference.calls),
      (inference.usdMicros / 1_000_000).toFixed(6),
      inference.unpricedCalls === 0 ? "yes" : "partial",
      `${inference.inputTokens} in / ${inference.outputTokens} out tokens; ${inference.unpricedCalls} unpriced`,
    ]);
    rows.push([
      scopeLabel,
      seat,
      "connectors",
      "calls",
      String(connectors.calls),
      connectors.usdMicros === null
        ? ""
        : (connectors.usdMicros / 1_000_000).toFixed(6),
      connectors.usdMicros === null
        ? "no"
        : connectors.unpricedCalls === 0
          ? "yes"
          : "partial",
      `${connectors.writes} write / ${connectors.reads} read; ${connectors.failed} failed`,
    ]);
  };

  meterRows(
    "*",
    report.totals.onchain,
    report.totals.inference,
    report.totals.connectors,
  );
  for (const seat of report.seats) {
    meterRows(
      seat.label ? `${seat.label} (${seat.agentId})` : seat.agentId,
      seat.onchain,
      seat.inference,
      seat.connectors,
    );
  }
  return [
    `# lacrew P&L ${scopeLabel} ${report.period.key} (${report.period.from} → ${report.period.to}, ${report.period.timezone})`,
    `# asOf ${report.asOf}; sources onchain=${report.sources.onchain.store}/${report.sources.onchain.complete ? "complete" : "partial"} inference=${report.sources.inference.store}/${report.sources.inference.complete ? "complete" : "partial"} connectors=${report.sources.connectors.store}/${report.sources.connectors.complete ? "complete" : "partial"}`,
    ...rows.map((r) => r.map(csvCell).join(",")),
  ].join("\n");
}

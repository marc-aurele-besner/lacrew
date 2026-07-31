/**
 * Unified seat / crew P&L (F2.33) — the runtime half.
 *
 * Gathers the three meters a desk's cost is spread across and hands them to the
 * pure aggregate in `@lacrew/flows`: the audit trail (onchain spend, pending
 * escalations, epoch grants, connector `ToolCalled` rows), the inference
 * metering F2.28 writes, and the two ceilings the report sits between
 * (Treasury allowance, inference budget).
 *
 * It reads. It never writes, never proposes, and never resolves — a reporting
 * surface that could act would be a second authority path for money, and there
 * is exactly one of those.
 *
 * Every meter reports where it came from and whether it could answer the whole
 * window. That is the difference between "this crew spent nothing" and "nothing
 * here can tell you what this crew spent", and an operator deciding whether a
 * desk is inside its budget needs to know which one they are looking at.
 */

import {
  buildPnlReport,
  budgetScopeKey,
  parseConnectorPrices,
  resolvePnlPeriod,
  type ConnectorPrices,
  type PnlAuditEvent,
  type PnlPeriodInput,
  type PnlReport,
  type PnlSource,
  type PnlUsageRow,
} from "@lacrew/flows";
import type { OrgNode } from "@lacrew/core";
import { ancestorsOf, subtreeOf } from "./flowScope.js";
import {
  UNATTRIBUTED_CREW_ID,
  crewIdForSeat,
  type InferenceBudgetsSurface,
} from "./inferenceBudgets.js";

/** Rows a single report will fold before it calls the window truncated. */
const AUDIT_ROW_CAP = 20_000;
const USAGE_ROW_CAP = 20_000;

export type PnlRequest = PnlPeriodInput & {
  crewId: string;
  /** Narrows the report to one seat; the roster table is then empty. */
  agentId?: string;
};

export type PnlSurface = {
  report(request: PnlRequest): Promise<PnlReport>;
};

/** What the surface needs from the runtime — kept narrow so tests can fake it. */
export type PnlRuntime = {
  auditBetween(
    fromIso: string,
    toIso: string,
    limit?: number,
  ): Promise<{
    events: Array<{
      type: string;
      at: string;
      payload: Record<string, unknown>;
    }>;
    complete: boolean;
    store: string;
  }>;
  getClient(): { getOrgTree(): Promise<OrgNode[]> };
  getAllowances(
    asset?: string,
  ): Promise<
    Array<{ node: string; token: string; balance: bigint; cap: bigint | null }>
  >;
  listAssets(): Array<{ symbol: string; token: string; decimals: number }>;
};

export function createPnl(opts: {
  runtime: PnlRuntime;
  budgets?: InferenceBudgetsSurface;
  /** USD per connector call, keyed `<connector>.<route>` or `<connector>`. */
  connectorPrices?: ConnectorPrices | null;
  now?: () => Date;
}): PnlSurface {
  const now = opts.now ?? (() => new Date());

  return {
    report: async (request) => {
      const crewId = (request.crewId ?? "").trim().toLowerCase();
      if (!crewId) throw new Error("crewId_required");
      // The shared bucket belongs to no crew, so it has no roster, no
      // allowance and no chart position — a P&L over it would be a report on
      // whoever else happens to share this orchestrator.
      if (crewId === UNATTRIBUTED_CREW_ID)
        throw new Error("unattributed_has_no_pnl");
      const agentId = request.agentId?.trim().toLowerCase() || undefined;
      const period = resolvePnlPeriod(request, now());

      // The chart decides the roster: a crew is its manager plus everything
      // reporting to it, the same reading budgets and connector policy use.
      const nodes = await opts.runtime
        .getClient()
        .getOrgTree()
        .catch(() => [] as OrgNode[]);
      const subtree = subtreeOf(nodes, crewId);
      const seats = nodes
        .filter((n) => subtree.has(n.account.toLowerCase()))
        .map((n) => {
          const account = n.account.toLowerCase();
          return {
            account,
            ...(n.label ? { label: n.label } : {}),
            // Where this seat's model calls are actually metered. Usually this
            // crew, but a manager's own calls are charged to the crew above it
            // and a sub-manager's team to the sub-manager — so the key is read
            // from the chart rather than assumed, or a subtree report would be
            // missing the seats it can see.
            usageScopeKey: budgetScopeKey({
              crewId: crewIdForSeat(account, [...ancestorsOf(nodes, account)]),
              agentId: account,
            }),
          };
        });
      // An empty or unreadable chart still reports the crew itself. Dropping to
      // "no seats" would render as a desk that did nothing.
      if (seats.length === 0) {
        seats.push({
          account: crewId,
          usageScopeKey: budgetScopeKey({ crewId, agentId: crewId }),
        });
      }
      if (agentId && !seats.some((s) => s.account === agentId)) {
        throw new Error("agent_not_in_crew");
      }

      const trail = await opts.runtime.auditBetween(
        period.from,
        period.to,
        AUDIT_ROW_CAP,
      );
      const events: PnlAuditEvent[] = trail.events.map((e) => ({
        type: e.type,
        at: e.at,
        payload: e.payload ?? {},
      }));
      // One store answers both chain-derived rows and connector rows, so they
      // share a provenance — stated twice rather than inferred once, because a
      // deployment could serve them from different places later.
      const trailSource: PnlSource = {
        available: true,
        complete: trail.complete,
        store: trail.store,
        ...(trail.store === "memory"
          ? {
              note: "No audit database is wired; the bounded in-process ring answered.",
            }
          : {}),
      };

      let usage: PnlUsageRow[] = [];
      let inferenceSource: PnlSource = {
        available: false,
        complete: false,
        store: "none",
        note: "Inference metering is not configured (F2.28).",
      };
      if (opts.budgets) {
        const scopeKeys = [
          budgetScopeKey({ crewId }),
          ...seats.map((s) => s.usageScopeKey),
        ];
        try {
          const metered = await opts.budgets.usageBetween({
            scopeKeys,
            fromIso: period.from,
            toIso: period.to,
            limit: USAGE_ROW_CAP,
          });
          usage = metered.events.map((e) => ({
            scopeKey: e.scopeKey,
            model: e.model,
            ...(e.provider ? { provider: e.provider } : {}),
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            usdMicros: e.usdMicros,
            priceSource: e.priceSource,
            ...(e.runId ? { runId: e.runId } : {}),
            ...(e.flowId ? { flowId: e.flowId } : {}),
            at: e.at,
          }));
          inferenceSource = {
            available: true,
            complete: metered.complete,
            store: opts.budgets.storeName,
          };
        } catch {
          // An unreadable meter is not a quiet one. Reported unavailable so the
          // zero below is never mistaken for a measured zero.
          inferenceSource = {
            available: false,
            complete: false,
            store: opts.budgets.storeName,
            note: "The inference meter could not be read for this window.",
          };
        }
      }

      const budgetView = opts.budgets
        ? await opts.budgets
            .get(agentId ? { crewId, agentId } : { crewId })
            .catch(() => null)
        : null;

      const primary = opts.runtime.listAssets()[0];
      const allowances = await opts.runtime
        .getAllowances()
        .then((rows) =>
          rows.map((row) => ({
            node: row.node.toLowerCase(),
            asset: primary?.symbol ?? "USDC",
            balance: row.balance.toString(),
            cap: row.cap === null ? null : row.cap.toString(),
          })),
        )
        .catch(() => []);

      return buildPnlReport({
        scope: { crewId, ...(agentId ? { agentId } : {}) },
        period,
        asOf: now().toISOString(),
        seats,
        events,
        usage,
        primaryAsset: primary?.symbol ?? "USDC",
        allowances,
        budget: budgetView
          ? {
              scopeKey: budgetView.scopeKey,
              periodKey: budgetView.period.key,
              periodFrom: budgetView.period.startsAt,
              periodTo: budgetView.period.endsAt,
              policy: budgetView.budget.policy,
              status: budgetView.status,
              ...(budgetView.budget.limits.maxUsd !== undefined
                ? { limitUsd: budgetView.budget.limits.maxUsd }
                : {}),
            }
          : null,
        connectorPrices: opts.connectorPrices,
        sources: {
          onchain: trailSource,
          connectors: trailSource,
          inference: inferenceSource,
        },
      });
    },
  };
}

/**
 * The connector price table an operator configured, or null.
 *
 * Nothing ships pre-priced: LaCrew does not know what a workspace pays GitHub
 * or Slack, and a number invented here would land in a report an accountant
 * reads as measured.
 */
export function connectorPricesFromEnv(
  env: Record<string, string | undefined> = process.env,
): ConnectorPrices | null {
  return parseConnectorPrices(env.LACREW_CONNECTOR_PRICES);
}

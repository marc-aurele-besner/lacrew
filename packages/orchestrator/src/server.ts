/**
 * Minimal HTTP surface for local self-host demos.
 * Mocked by default; onchain when ANVIL_RPC + PRIVATE_KEY are set.
 * TODO: Move to Hono/Fastify + auth.
 * Queue: QueueProvider — pg-boss when DATABASE_URL set, else in-memory.
 */

import { createServer } from "node:http";
import { checkDbReady, getDatabaseUrl } from "@lacrew/db";
import { createRuntimeFromEnv } from "./runtime.js";
import { createQueueFromEnv, type QueueProvider } from "./queue/index.js";

const runtime = createRuntimeFromEnv();
const port = Number(process.env.PORT ?? 8788);
let queue: QueueProvider = createQueueFromEnv();
let dbReady = false;

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, {
        ok: true,
        service: "lacrew-orchestrator",
        mocked: runtime.mode === "mock",
        mode: runtime.mode,
        chainId: runtime.chainId,
        db: { configured: Boolean(getDatabaseUrl()), ready: dbReady },
        queue: queue.status(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/boot") {
      send(res, 200, { session: await runtime.boot() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      send(res, 200, {
        sessions: await runtime.listSessions(),
        mode: runtime.mode,
        chainId: runtime.chainId,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/sessions/revoke") {
      const body = (await readBody(req)) as { sessionId?: string };
      if (!body.sessionId) {
        send(res, 400, { error: "sessionId_required" });
        return;
      }
      const result = await runtime.revokeSessionById(body.sessionId);
      send(res, 200, { ...result, mode: runtime.mode });
      return;
    }

    if (req.method === "POST" && url.pathname === "/tick") {
      const body = (await readBody(req)) as { value?: string };
      const value = body.value ? BigInt(body.value) : 75n * 10n ** 6n;
      send(res, 200, await runtime.tick(value));
      return;
    }

    if (req.method === "GET" && url.pathname === "/intents") {
      send(res, 200, { intents: await runtime.listPending() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/audit") {
      send(res, 200, { events: await runtime.audit() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/org") {
      send(res, 200, {
        nodes: await runtime.getClient().getOrgTree(),
        mode: runtime.mode,
        chainId: runtime.chainId,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/intents/resolve") {
      const body = (await readBody(req)) as {
        intentId?: string;
        approved?: boolean;
        approver?: `0x${string}`;
      };
      if (!body.intentId || typeof body.approved !== "boolean") {
        send(res, 400, { error: "intentId_and_approved_required" });
        return;
      }
      const result = await runtime.resolve(body.intentId, body.approved, body.approver);
      send(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/governance/proposals") {
      send(res, 200, {
        proposals: await runtime.listProposals(),
        mode: runtime.mode,
        chainId: runtime.chainId,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/governance/propose-hire") {
      const body = (await readBody(req)) as {
        label?: string;
        kind?: "manager_agent" | "worker_agent";
        parent?: `0x${string}`;
        tier?: "low" | "high";
      };
      if (!body.label?.trim()) {
        send(res, 400, { error: "label_required" });
        return;
      }
      const result = await runtime.proposeHire({
        label: body.label.trim(),
        kind: body.kind,
        parent: body.parent,
        tier: body.tier,
      });
      send(res, 200, { ...result, mode: runtime.mode });
      return;
    }

    if (req.method === "POST" && url.pathname === "/governance/propose-fire") {
      const body = (await readBody(req)) as {
        account?: `0x${string}`;
        tier?: "low" | "high";
      };
      if (!body.account) {
        send(res, 400, { error: "account_required" });
        return;
      }
      const result = await runtime.proposeFire({
        account: body.account,
        tier: body.tier,
      });
      send(res, 200, { ...result, mode: runtime.mode });
      return;
    }

    if (req.method === "POST" && url.pathname === "/governance/propose-reparent") {
      const body = (await readBody(req)) as {
        account?: `0x${string}`;
        newParent?: `0x${string}`;
        tier?: "low" | "high";
      };
      if (!body.account || !body.newParent) {
        send(res, 400, { error: "account_and_newParent_required" });
        return;
      }
      const result = await runtime.proposeReparent({
        account: body.account,
        newParent: body.newParent,
        tier: body.tier,
      });
      send(res, 200, { ...result, mode: runtime.mode });
      return;
    }

    if (req.method === "POST" && url.pathname === "/governance/propose-set-grant") {
      const body = (await readBody(req)) as {
        account?: `0x${string}`;
        amount?: string | number;
        tier?: "low" | "high";
      };
      if (!body.account || body.amount === undefined || body.amount === "") {
        send(res, 400, { error: "account_and_amount_required" });
        return;
      }
      const amount = BigInt(body.amount);
      const result = await runtime.proposeSetGrant({
        account: body.account,
        amount,
        tier: body.tier,
      });
      send(res, 200, { ...result, mode: runtime.mode, amount: amount.toString() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/governance/vote") {
      const body = (await readBody(req)) as { proposalId?: string; support?: boolean };
      if (!body.proposalId || typeof body.support !== "boolean") {
        send(res, 400, { error: "proposalId_and_support_required" });
        return;
      }
      const result = await runtime.voteGovernance(body.proposalId, body.support);
      send(res, 200, { ...result, mode: runtime.mode });
      return;
    }

    if (req.method === "POST" && url.pathname === "/governance/veto") {
      const body = (await readBody(req)) as { proposalId?: string };
      if (!body.proposalId) {
        send(res, 400, { error: "proposalId_required" });
        return;
      }
      const result = await runtime.vetoGovernance(body.proposalId);
      send(res, 200, { ...result, mode: runtime.mode });
      return;
    }

    if (req.method === "POST" && url.pathname === "/governance/execute") {
      const body = (await readBody(req)) as { proposalId?: string };
      if (!body.proposalId) {
        send(res, 400, { error: "proposalId_required" });
        return;
      }
      const result = await runtime.executeGovernance(body.proposalId);
      send(res, 200, { ...result, mode: runtime.mode });
      return;
    }

    if (req.method === "GET" && url.pathname === "/epoch") {
      const q = queue.status();
      send(res, 200, {
        currentEpoch: await runtime.getCurrentEpoch(),
        mode: runtime.mode,
        chainId: runtime.chainId,
        schedule: q.epochSchedule ?? null,
        queue: q.provider,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/epoch") {
      const result = await runtime.runEpoch();
      send(res, 200, { ...result, mode: runtime.mode });
      return;
    }

    send(res, 404, { error: "not_found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : "unknown" });
  }
});

async function main(): Promise<void> {
  dbReady = await checkDbReady();
  await queue.start({
    onEpoch: async () => runtime.runEpoch(),
    onTick: async () => runtime.tick(),
  });

  // pg-boss: EPOCH_CRON (default hourly). memory: EPOCH_INTERVAL_MS (>0) opt-in.
  await queue.scheduleEpoch(process.env.EPOCH_CRON ?? "0 * * * *");

  server.listen(port, () => {
    const q = queue.status();
    // eslint-disable-next-line no-console
    console.log(
      `[@lacrew/orchestrator] ${runtime.mode} server listening on :${port}` +
        (runtime.chainId != null ? ` (chain ${runtime.chainId})` : "") +
        ` queue=${q.provider}` +
        (q.epochSchedule ? ` epoch=${q.epochSchedule}` : "") +
        ` db=${dbReady ? "ready" : getDatabaseUrl() ? "unreachable" : "off"}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Minimal HTTP surface for local self-host demos.
 * Mocked: Node http only; no auth, no multi-tenant isolation.
 * TODO: Move to Hono/Fastify + auth + BullMQ workers.
 */

import { createServer } from "node:http";
import { CrewRuntime } from "./runtime.js";

const runtime = new CrewRuntime();
const port = Number(process.env.PORT ?? 8788);

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
      send(res, 200, { ok: true, service: "lacrew-orchestrator", mocked: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/boot") {
      send(res, 200, { session: await runtime.boot() });
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
      send(res, 200, { nodes: await runtime.getClient().getOrgTree() });
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

    send(res, 404, { error: "not_found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : "unknown" });
  }
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[@lacrew/orchestrator] Mocked server listening on :${port}`);
});

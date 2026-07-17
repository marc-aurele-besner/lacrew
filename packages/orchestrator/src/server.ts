/**
 * Minimal HTTP surface for local self-host demos.
 * Mocked: Node http only; no auth, no multi-tenant isolation.
 * TODO: Move to Hono/Fastify + auth + BullMQ workers.
 */

import { createServer } from "node:http";
import { CrewRuntime } from "./runtime.js";

const runtime = new CrewRuntime();
const port = Number(process.env.PORT ?? 8788);

const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");

  try {
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ ok: true, service: "lacrew-orchestrator" }));
      return;
    }

    if (req.method === "POST" && req.url === "/boot") {
      const session = await runtime.boot();
      res.end(JSON.stringify({ session }));
      return;
    }

    if (req.method === "POST" && req.url === "/tick") {
      const result = await runtime.tick();
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "GET" && req.url === "/intents") {
      const intents = await runtime.listPending();
      // Serialize bigints for JSON.
      res.end(
        JSON.stringify(intents, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : "unknown" }));
  }
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[@lacrew/orchestrator] Mocked server listening on :${port}`);
});

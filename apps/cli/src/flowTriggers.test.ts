import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cmdFlows, triggerError } from "./flows.js";

/** One recorded call against the orchestrator's HTTP surface. */
type Call = { path: string; method: string; body: unknown };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let responder: (call: Call) => { status?: number; body: unknown };

/**
 * Stand in for a running orchestrator. The CLI is the unit under test, so what
 * matters is the request it composes and the output it prints from the answer —
 * not that a real server is listening.
 */
function installFetch(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    const call: Call = {
      path: href.replace("http://127.0.0.1:8788", ""),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function capture(args: string[]): Promise<{ out: string; err: string; code?: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const priorCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    await cmdFlows(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode;
  process.exitCode = priorCode;
  return { out: out.join("\n"), err: err.join("\n"), code: code as number | undefined };
}

const TRIGGER = {
  id: "wht_abc",
  flowId: "pr-triage",
  scheme: "github",
  enabled: true,
  events: ["pull_request"],
  secretVersion: 1,
};

describe("lacrew flows triggers", () => {
  beforeEach(() => {
    calls = [];
    responder = () => ({ body: {} });
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lists triggers with their source, filter and principal", async () => {
    responder = () => ({ body: { triggers: [TRIGGER] } });
    const { out } = await capture(["triggers", "list"]);
    assert.match(out, /wht_abc\s+→\s+pr-triage/);
    assert.match(out, /enabled/);
    assert.match(out, /github/);
    assert.match(out, /events=pull_request/);
    assert.match(out, /as crew default/);
    assert.equal(calls[0]?.path, "/flows/triggers");
  });

  it("points at create when nothing is registered yet", async () => {
    responder = () => ({ body: { triggers: [] } });
    const { out } = await capture(["triggers", "list"]);
    assert.match(out, /lacrew flows triggers create --flow/);
  });

  it("sends the event filter and field map it was given", async () => {
    responder = () => ({ body: { trigger: TRIGGER, secret: "s3cr3t-value" } });
    await capture([
      "triggers",
      "create",
      "--flow",
      "pr-triage",
      "--source",
      "github",
      "--events",
      "pull_request, push",
      "--field",
      "pr=pull_request.number",
      "--field",
      "title=pull_request.title",
    ]);
    assert.deepEqual(calls[0]?.body, {
      flowId: "pr-triage",
      scheme: "github",
      events: ["pull_request", "push"],
      input: { fields: { pr: "pull_request.number", title: "pull_request.title" } },
    });
  });

  it("prints the secret once, and says so where it is read", async () => {
    responder = () => ({ body: { trigger: TRIGGER, secret: "s3cr3t-value" } });
    const { out } = await capture(["triggers", "create", "--flow", "pr-triage"]);
    assert.match(out, /s3cr3t-value/);
    assert.match(out, /shown once/i);
    assert.match(out, /hooks\/wht_abc/);
  });

  it("explains the absence of a secret rather than printing an empty one", async () => {
    const pubsub = { ...TRIGGER, scheme: "google-pubsub", secretVersion: undefined };
    responder = () => ({ body: { trigger: pubsub } });
    const { out } = await capture([
      "triggers",
      "create",
      "--flow",
      "pr-triage",
      "--source",
      "google-pubsub",
      "--audience",
      "https://orch.example/hooks/x",
      "--service-account",
      "pusher@proj.iam.gserviceaccount.com",
    ]);
    assert.match(out, /authenticates its sender/);
    assert.doesNotMatch(out, /shown once/i);
    assert.deepEqual((calls[0]?.body as { config?: unknown }).config, {
      audience: "https://orch.example/hooks/x",
      serviceAccountEmail: "pusher@proj.iam.gserviceaccount.com",
    });
  });

  it("says the old secret is dead after a rotate", async () => {
    responder = () => ({
      body: { trigger: { ...TRIGGER, secretVersion: 2 }, secret: "next-secret" },
    });
    const { out } = await capture(["triggers", "rotate", "wht_abc"]);
    assert.match(out, /version 2/);
    assert.match(out, /no longer verifies/);
    assert.match(out, /next-secret/);
    assert.equal(calls[0]?.path, "/flows/triggers/rotate");
  });

  it("toggles enabled state through the orchestrator", async () => {
    responder = () => ({ body: { trigger: { ...TRIGGER, enabled: false } } });
    const { out } = await capture(["triggers", "disable", "wht_abc"]);
    assert.deepEqual(calls[0]?.body, { id: "wht_abc", enabled: false });
    assert.match(out, /disabled/);
  });

  it("renders the delivery log with reasons, and exits clean when empty", async () => {
    responder = () => ({
      body: {
        deliveries: [
          {
            triggerId: "wht_abc",
            deliveryKey: "d1",
            result: "run_started",
            runId: "run-wh-1",
            at: "2026-07-30T10:00:00Z",
            bytes: 80,
          },
          {
            triggerId: "wht_abc",
            deliveryKey: "d2",
            result: "rejected",
            reason: "webhook_signature_invalid",
            at: "2026-07-30T09:00:00Z",
          },
        ],
      },
    });
    const { out } = await capture(["triggers", "deliveries", "wht_abc"]);
    assert.match(out, /run_started/);
    assert.match(out, /run run-wh-1/);
    assert.match(out, /webhook_signature_invalid/);
    assert.match(calls[0]?.path ?? "", /triggerId=wht_abc/);

    responder = () => ({ body: { deliveries: [] } });
    const empty = await capture(["triggers", "deliveries"]);
    assert.match(empty.out, /No deliveries/);
    assert.equal(empty.code, undefined);
  });

  it("prints a signing example that covers the exact bytes sent", async () => {
    const { out } = await capture(["triggers", "curl", "wht_abc"]);
    // The mistake this exists to prevent: signing a re-serialized body.
    assert.match(out, /printf '%s\.%s' "\$TS" "\$BODY"/);
    assert.match(out, /X-Lacrew-Signature: sha256=\$SIG/);
    assert.match(out, /hooks\/wht_abc/);
    assert.equal(calls.length, 0, "printing an example must not call the orchestrator");
  });

  it("requires --flow on create", async () => {
    const { err, code } = await capture(["triggers", "create"]);
    assert.match(err, /--flow <flowId>/);
    assert.equal(code, 1);
  });

  it("lists its subcommands when given none", async () => {
    const { out } = await capture(["triggers"]);
    assert.match(out, /triggers list/);
    assert.match(out, /triggers rotate/);
    assert.match(out, /triggers deliveries/);
  });
});

describe("trigger error translation", () => {
  it("turns the orchestrator's refusal codes into an operator's next action", () => {
    // A raw `flow_not_webhook_triggered` tells an operator nothing about the
    // fact that the *definition* is what has to change.
    assert.match(
      triggerError(new Error("flows_http_400: flow_not_webhook_triggered")),
      /does not declare trigger: "webhook"/,
    );
    assert.match(
      triggerError(new Error("flows_http_503: webhook_sealing_unavailable")),
      /openssl rand -base64 32/,
    );
    assert.match(
      triggerError(new Error("flows_http_400: source_config_required: audience")),
      /--audience and --service-account/,
    );
    assert.match(
      triggerError(new Error("flows_http_400: source_has_no_secret")),
      /nothing to rotate/,
    );
    // Anything unrecognized is passed through rather than swallowed.
    assert.equal(triggerError(new Error("boom")), "boom");
  });
});

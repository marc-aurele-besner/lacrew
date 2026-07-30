import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow, type FlowDefinition } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore, type FlowStore } from "./flowStore.js";
import { MemoryModelProvider } from "./model/index.js";
import {
  createWebhookSurface,
  mapWebhookInput,
  readPath,
  type WebhookJob,
  type WebhookSurface,
  type WebhookTrigger,
} from "./webhooks.js";
import { createMemoryWebhookStore } from "./webhookStore.js";
import { createSign, generateKeyPairSync } from "node:crypto";
import { resetGoogleJwksCache, type Jwk, type JwksFetcher } from "./googleOidc.js";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signGithubDelivery,
  signLacrewDelivery,
} from "./webhookSignature.js";

const BODY = JSON.stringify({
  action: "opened",
  pull_request: { number: 7, title: "Add hooks", user: { login: "octocat" } },
});

async function makeSurface(
  opts: {
    flowId?: string;
    trigger?: "webhook" | "manual";
    jwksFetcher?: JwksFetcher;
  } = {},
) {
  const runtime = new CrewRuntime({
    client: createLacrewClient({ useMock: true }),
  });
  const flows = createFlowsSurface({
    runtime,
    model: new MemoryModelProvider(),
    store: createMemoryFlowStore(),
  });
  const id = opts.flowId ?? "pr-triage";
  const def = flow(id, "PR triage")
    .model("summarize", { prompt: "{{input}}" })
    .build();
  await flows.save({ ...def, trigger: opts.trigger ?? "webhook" });

  const jobs: WebhookJob[] = [];
  const webhooks = createWebhookSurface({
    runtime,
    flows,
    store: createMemoryWebhookStore(),
    ...(opts.jwksFetcher ? { jwksFetcher: opts.jwksFetcher } : {}),
    enqueue: async (job) => {
      jobs.push(job);
    },
  });
  return { runtime, flows, webhooks, jobs, flowId: id };
}

/** Headers a correctly-behaved `lacrew` producer sends. */
function signed(
  secret: string,
  body: string,
  extra: Record<string, string> = {},
): (name: string) => string | undefined {
  const ts = Math.floor(Date.now() / 1000);
  const map: Record<string, string> = {
    [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(secret, ts, body),
    [TIMESTAMP_HEADER]: String(ts),
    ...extra,
  };
  return (name) => map[name.toLowerCase()];
}

function deliver(
  webhooks: WebhookSurface,
  triggerId: string,
  secret: string,
  body = BODY,
) {
  return webhooks.accept({
    triggerId,
    rawBody: body,
    header: signed(secret, body),
  });
}

/**
 * create/rotate return an *optional* secret, because a source can authenticate
 * its sender instead of sharing a key (Google Pub/Sub). Every case below uses
 * an HMAC source, so asserting it here keeps the assertions about behaviour
 * rather than about narrowing a union.
 */
async function createSigned(
  surface: WebhookSurface,
  input: Parameters<WebhookSurface["create"]>[0],
): Promise<{ trigger: WebhookTrigger; secret: string }> {
  const made = await surface.create(input);
  assert.ok(made.secret, "an HMAC source must mint a secret");
  return { trigger: made.trigger, secret: made.secret };
}

async function rotateSigned(
  surface: WebhookSurface,
  id: string,
): Promise<{ trigger: WebhookTrigger; secret: string }> {
  const made = await surface.rotate(id);
  assert.ok(made.secret, "an HMAC source must mint a secret");
  return { trigger: made.trigger, secret: made.secret };
}

const PUBSUB_AUD = "https://orch.example.com/hooks/test";
const PUBSUB_SA = "pusher@proj.iam.gserviceaccount.com";

/**
 * A throwaway Google-shaped signer: real RSA keys, real RS256, served through
 * the injected JWKS seam so nothing reaches Google and no key is committed.
 */
function makePubsubSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "pk-1", alg: "RS256" } as Jwk;
  resetGoogleJwksCache();
  return {
    jwks: (async () => ({ keys: [jwk] })) as JwksFetcher,
    token(overrides: Record<string, unknown> = {}): string {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const input = `${b64({ alg: "RS256", kid: "pk-1", typ: "JWT" })}.${b64({
        iss: "https://accounts.google.com",
        aud: PUBSUB_AUD,
        email: PUBSUB_SA,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 600,
        ...overrides,
      })}`;
      const signer = createSign("RSA-SHA256");
      signer.update(input);
      signer.end();
      return `${input}.${signer.sign(privateKey).toString("base64url")}`;
    },
  };
}

describe("webhook input mapping", () => {
  it("reads dot paths, including array indexes", () => {
    const body = JSON.parse(BODY) as unknown;
    assert.equal(readPath(body, "pull_request.title"), "Add hooks");
    assert.equal(readPath(body, "pull_request.user.login"), "octocat");
    assert.equal(readPath(JSON.parse('{"c":[{"id":"a1"}]}'), "c.0.id"), "a1");
    assert.equal(readPath(body, "pull_request.missing"), undefined);
    assert.equal(readPath(body, "action.nope"), undefined);
  });

  it("passes the whole body through when no mapping is declared", () => {
    assert.deepEqual(
      JSON.parse(mapWebhookInput(JSON.parse(BODY), undefined)),
      JSON.parse(BODY),
    );
  });

  it("builds a flat object from a field map so {{input.x}} resolves", () => {
    const mapped = mapWebhookInput(JSON.parse(BODY), {
      fields: { pr: "pull_request.number", title: "pull_request.title" },
    });
    assert.deepEqual(JSON.parse(mapped), { pr: "7", title: "Add hooks" });
  });

  it("lifts a single value with path, and renders a missing one as empty", () => {
    assert.equal(
      mapWebhookInput(JSON.parse(BODY), { path: "pull_request.title" }),
      "Add hooks",
    );
    assert.equal(
      mapWebhookInput(JSON.parse(BODY), { path: "nope.at.all" }),
      "",
    );
  });
});

describe("webhook triggers", () => {
  it("mints a trigger with a one-time secret and never lists it back", async () => {
    const { webhooks } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });
    assert.match(trigger.id, /^wht_/);
    assert.equal(trigger.enabled, true);
    assert.equal(trigger.secretVersion, 1);
    assert.ok(secret.length > 0);

    const listed = JSON.stringify(webhooks.list());
    assert.ok(!listed.includes(secret), "listing must not carry the secret");
    assert.ok(!listed.includes("secretSealed"));
  });

  it("refuses to point a hook at a flow that does not declare the trigger", async () => {
    const { webhooks } = await makeSurface({ trigger: "manual" });
    await assert.rejects(
      () => webhooks.create({ flowId: "pr-triage" }),
      /flow_not_webhook_triggered/,
    );
    await assert.rejects(
      () => webhooks.create({ flowId: "nope" }),
      /flow_not_found/,
    );
  });

  it("accepts a signed delivery and enqueues exactly one job", async () => {
    const { webhooks, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });

    const accepted = await deliver(webhooks, trigger.id, secret);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.status, 202);
    assert.equal(jobs.length, 1);
    assert.equal(
      jobs[0]?.runId,
      accepted.ok && accepted.status === 202 ? accepted.runId : "",
    );
    assert.deepEqual(JSON.parse(jobs[0]!.input), JSON.parse(BODY));
  });

  it("never enqueues on an invalid signature", async () => {
    const { webhooks, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });

    const forged = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: BODY,
      header: signed("not-the-secret", BODY),
    });
    assert.deepEqual(forged, {
      ok: false,
      status: 401,
      error: "webhook_signature_invalid",
    });
    assert.equal(jobs.length, 0);

    // Unsigned entirely.
    const bare = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: BODY,
      header: () => undefined,
    });
    assert.equal(bare.ok, false);
    assert.equal(jobs.length, 0);

    // And the correctly signed one still works, so the refusals were not blanket.
    assert.equal((await deliver(webhooks, trigger.id, secret)).ok, true);
    assert.equal(jobs.length, 1);
  });

  it("rotates the secret: the old signature stops working, the new one starts", async () => {
    const { webhooks, jobs } = await makeSurface();
    const created = await createSigned(webhooks, { flowId: "pr-triage" });
    const rotated = await rotateSigned(webhooks, created.trigger.id);
    assert.notEqual(rotated.secret, created.secret);
    assert.equal(rotated.trigger.secretVersion, 2);

    const stale = await deliver(webhooks, created.trigger.id, created.secret);
    assert.equal(stale.ok, false);
    assert.equal(jobs.length, 0);

    const fresh = await deliver(webhooks, created.trigger.id, rotated.secret);
    assert.equal(fresh.ok, true);
    assert.equal(jobs.length, 1);
  });

  it("treats a redelivered idempotency key as a duplicate, not a second run", async () => {
    const { webhooks, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });
    const header = signed(secret, BODY, { "idempotency-key": "delivery-1" });

    const first = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: BODY,
      header,
    });
    const second = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: BODY,
      header,
    });

    assert.equal(first.ok && first.status, 202);
    assert.equal(second.ok && second.status, 200);
    assert.equal(second.ok && "duplicate" in second && second.duplicate, true);
    assert.equal(jobs.length, 1, "a replay must not enqueue a second run");
  });

  it("refuses a disabled trigger and resumes when re-enabled", async () => {
    const { webhooks, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });

    await webhooks.setEnabled(trigger.id, false);
    const off = await deliver(webhooks, trigger.id, secret);
    assert.deepEqual(off, {
      ok: false,
      status: 403,
      error: "webhook_trigger_disabled",
    });
    assert.equal(jobs.length, 0);

    await webhooks.setEnabled(trigger.id, true);
    assert.equal((await deliver(webhooks, trigger.id, secret)).ok, true);
    assert.equal(jobs.length, 1);
  });

  it("refuses an unknown trigger and a body over the cap", async () => {
    const { webhooks } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });

    assert.deepEqual(await deliver(webhooks, "wht_nope", secret), {
      ok: false,
      status: 404,
      error: "webhook_trigger_not_found",
    });

    const huge = JSON.stringify({ blob: "x".repeat(2_000_000) });
    const over = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: huge,
      header: signed(secret, huge),
    });
    assert.deepEqual(over, {
      ok: false,
      status: 413,
      error: "webhook_body_too_large",
    });
  });

  it("refuses a signed body that is not JSON", async () => {
    const { webhooks, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });
    const body = "not json at all";
    const bad = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: body,
      header: signed(secret, body),
    });
    assert.deepEqual(bad, {
      ok: false,
      status: 400,
      error: "webhook_body_invalid",
    });
    assert.equal(jobs.length, 0);
  });

  it("rejects rather than silently skips a paused principal", async () => {
    const { runtime, webhooks, jobs } = await makeSurface();
    const principal = runtime.defaultAgent;
    const { trigger, secret } = await createSigned(webhooks, {
      flowId: "pr-triage",
      principal,
    });

    await runtime.pauseAgent(principal, "maintenance");
    const paused = await deliver(webhooks, trigger.id, secret);
    assert.deepEqual(paused, {
      ok: false,
      status: 403,
      error: "webhook_principal_paused",
    });
    assert.equal(
      jobs.length,
      0,
      "a paused principal must not have work queued for it",
    );

    runtime.resumeAgent(principal);
    assert.equal((await deliver(webhooks, trigger.id, secret)).ok, true);
  });

  it("verifies a github-scheme delivery over the body alone", async () => {
    const { webhooks, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, {
      flowId: "pr-triage",
      scheme: "github",
      input: { fields: { pr: "pull_request.number" } },
    });
    const map: Record<string, string> = {
      [SIGNATURE_HEADER.github]: signGithubDelivery(secret, BODY),
      "x-github-delivery": "gh-delivery-1",
    };
    const accepted = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: BODY,
      header: (name) => map[name.toLowerCase()],
    });
    assert.equal(accepted.ok && accepted.status, 202);
    assert.deepEqual(JSON.parse(jobs[0]!.input), { pr: "7" });
    // GitHub's delivery id is the idempotency key, so a redelivery is a no-op.
    const again = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: BODY,
      header: (name) => map[name.toLowerCase()],
    });
    assert.equal(again.ok && again.status, 200);
    assert.equal(jobs.length, 1);
  });

  it("runs the flow only on deliver(), under the trigger's runId", async () => {
    const { webhooks, flows, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });
    const accepted = await deliver(webhooks, trigger.id, secret);
    assert.equal(accepted.ok && accepted.status, 202);
    assert.equal(flows.runs().length, 0, "accept must not run the flow");

    const result = await webhooks.deliver(jobs[0]!);
    assert.equal(result?.runId, jobs[0]!.runId);
    assert.equal(result?.trigger, "webhook");
    assert.equal(flows.runs().length, 1);

    const log = await webhooks.deliveries();
    const line = log.find((d) => d.deliveryKey === jobs[0]!.deliveryKey);
    assert.equal(line?.result, "run_started");
    assert.equal(line?.runId, jobs[0]!.runId);
  });

  it("logs a rejection under its own key so a valid retry is not swallowed", async () => {
    const { webhooks, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });
    const header = signed(secret, BODY, { "idempotency-key": "delivery-9" });

    // A forged attempt carrying the same idempotency key the real producer
    // will use on its retry.
    await webhooks.accept({
      triggerId: trigger.id,
      rawBody: BODY,
      header: signed("wrong", BODY, { "idempotency-key": "delivery-9" }),
    });
    const retry = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: BODY,
      header,
    });
    assert.equal(retry.ok && retry.status, 202);
    assert.equal(jobs.length, 1);

    const log = await webhooks.deliveries();
    assert.equal(log.filter((d) => d.result === "rejected").length, 1);
    assert.equal(
      log.find((d) => d.result === "rejected")?.reason,
      "webhook_signature_invalid",
    );
  });

  it("resolves a trigger another replica minted, and its rotation", async () => {
    // pg-boss hands a delivery to whichever replica is free, which is routinely
    // not the one that minted the trigger. A surface that resolved only from
    // the map it hydrated at boot 404s every hook created since it started.
    const previous = process.env.LACREW_SESSION_KEY;
    process.env.LACREW_SESSION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const base = createMemoryWebhookStore();
      // Durable, so secrets go through the seal/unseal path a shared Postgres
      // would use — the only way a second process can verify at all.
      const shared = { ...base, durable: true };

      const first = await makeSurface();
      const replicaA = createWebhookSurface({
        runtime: first.runtime,
        flows: first.flows,
        store: shared,
        enqueue: async () => {},
      });
      const jobsB: WebhookJob[] = [];
      const replicaB = createWebhookSurface({
        runtime: first.runtime,
        flows: first.flows,
        store: shared,
        enqueue: async (job) => {
          jobsB.push(job);
        },
      });
      // B booted before the trigger existed, and never hydrates again.
      await replicaB.hydrate();

      const { trigger, secret } = await createSigned(replicaA, {
        flowId: "pr-triage",
      });
      assert.equal(
        replicaB.list().length,
        0,
        "B's boot-time map cannot know it",
      );

      const onB = await deliver(replicaB, trigger.id, secret);
      assert.equal(onB.ok && onB.status, 202);
      assert.equal(jobsB.length, 1);

      // A rotation on A must stop verifying on B too, without restarting it.
      const rotated = await rotateSigned(replicaA, trigger.id);
      const stale = await deliver(replicaB, trigger.id, secret);
      assert.equal(stale.ok, false);
      assert.equal(
        (await deliver(replicaB, trigger.id, rotated.secret)).ok,
        true,
        "B must pick up the new secret, not serve the old one for its lifetime",
      );

      // And B can run a job for a trigger it never saw created.
      const ran = await replicaB.deliver(jobsB[0]!);
      assert.equal(ran?.trigger, "webhook");
    } finally {
      if (previous === undefined) delete process.env.LACREW_SESSION_KEY;
      else process.env.LACREW_SESSION_KEY = previous;
    }
  });

  it("refuses to persist a secret it cannot seal", async () => {
    const previous = process.env.LACREW_SESSION_KEY;
    delete process.env.LACREW_SESSION_KEY;
    try {
      const { runtime, flows } = await makeSurface();
      const durable = { ...createMemoryWebhookStore(), durable: true };
      const webhooks = createWebhookSurface({
        runtime,
        flows,
        store: durable,
        enqueue: async () => {},
      });
      // Cleartext in a store that outlives the process would make a database
      // dump enough to start funded flows, so this fails loudly.
      await assert.rejects(
        () => webhooks.create({ flowId: "pr-triage" }),
        /webhook_sealing_unavailable/,
      );
      assert.equal(webhooks.list().length, 0);
    } finally {
      if (previous !== undefined) process.env.LACREW_SESSION_KEY = previous;
    }
  });

  it("runs only the GitHub events a trigger subscribed to", async () => {
    const { webhooks, jobs } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, {
      flowId: "pr-triage",
      scheme: "github",
      events: ["pull_request"],
    });

    const opened = JSON.stringify({ action: "opened", pull_request: { number: 7 } });
    const wanted = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: opened,
      header: (n) =>
        ({
          [SIGNATURE_HEADER.github]: signGithubDelivery(secret, opened),
          "x-github-event": "pull_request",
          "x-github-delivery": "gh-1",
        })[n.toLowerCase()],
    });
    assert.equal(wanted.ok && wanted.status, 202);
    assert.equal(jobs.length, 1);

    const issue = JSON.stringify({ action: "opened", issue: { number: 3 } });
    const unwanted = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: issue,
      header: (n) =>
        ({
          [SIGNATURE_HEADER.github]: signGithubDelivery(secret, issue),
          "x-github-event": "issues",
          "x-github-delivery": "gh-2",
        })[n.toLowerCase()],
    });
    // 2xx, not 4xx: GitHub disables a hook that keeps erroring, and "not
    // subscribed" is not a delivery failure.
    assert.equal(unwanted.ok, true);
    assert.equal(unwanted.ok && "skipped" in unwanted && unwanted.skipped, "event_not_selected");
    assert.equal(jobs.length, 1, "an unsubscribed event must not start a run");

    const log = await webhooks.deliveries();
    assert.ok(log.some((d) => d.result === "skipped" && d.reason?.includes("issues.opened")));
  });

  it("accepts a Google Pub/Sub push and maps the unwrapped message", async () => {
    const signer = makePubsubSigner();
    const { webhooks, jobs } = await makeSurface({ jwksFetcher: signer.jwks });
    const { trigger, secret } = await webhooks
      .create({
        flowId: "pr-triage",
        scheme: "google-pubsub",
        config: { audience: PUBSUB_AUD, serviceAccountEmail: PUBSUB_SA },
        input: { fields: { mailbox: "emailAddress" } },
      })
      .then((made) => ({ trigger: made.trigger, secret: made.secret }));
    // No shared secret for this source — Google signs the sender instead.
    assert.equal(secret, undefined);
    assert.equal(trigger.secretVersion, undefined);

    const body = JSON.stringify({
      message: {
        data: Buffer.from(JSON.stringify({ emailAddress: "ops@example.com", historyId: 42 })).toString("base64"),
        messageId: "pubsub-msg-1",
      },
      subscription: "projects/p/subscriptions/s",
    });
    const push = (auth: string) =>
      webhooks.accept({
        triggerId: trigger.id,
        rawBody: body,
        header: (n) => (n.toLowerCase() === "authorization" ? auth : undefined),
      });

    const accepted = await push(`Bearer ${signer.token()}`);
    assert.equal(accepted.ok && accepted.status, 202);
    // The flow sees the decoded message, not the base64 envelope.
    assert.deepEqual(JSON.parse(jobs[0]!.input), { mailbox: "ops@example.com" });
    assert.equal(jobs[0]!.deliveryKey, "pubsub-msg-1", "messageId is the idempotency key");

    // Redelivery of the same messageId is a no-op.
    assert.equal((await push(`Bearer ${signer.token()}`)).ok, true);
    assert.equal(jobs.length, 1);
  });

  it("refuses a Pub/Sub push minted for another audience, and never enqueues", async () => {
    const signer = makePubsubSigner();
    const { webhooks, jobs } = await makeSurface({ jwksFetcher: signer.jwks });
    const { trigger } = await webhooks.create({
      flowId: "pr-triage",
      scheme: "google-pubsub",
      config: { audience: PUBSUB_AUD, serviceAccountEmail: PUBSUB_SA },
    });
    const body = JSON.stringify({ message: { data: "e30=", messageId: "m-1" } });
    const bad = await webhooks.accept({
      triggerId: trigger.id,
      rawBody: body,
      header: (n) =>
        n.toLowerCase() === "authorization"
          ? `Bearer ${signer.token({ aud: "https://someone-else.example" })}`
          : undefined,
    });
    assert.deepEqual(bad, {
      ok: false,
      status: 401,
      error: "webhook_token_audience_invalid",
    });
    assert.equal(jobs.length, 0);
  });

  it("refuses to create a Pub/Sub trigger without its bindings, or rotate a secretless one", async () => {
    const signer = makePubsubSigner();
    const { webhooks } = await makeSurface({ jwksFetcher: signer.jwks });
    await assert.rejects(
      () => webhooks.create({ flowId: "pr-triage", scheme: "google-pubsub" }),
      /source_config_required: audience, serviceAccountEmail/,
    );
    const { trigger } = await webhooks.create({
      flowId: "pr-triage",
      scheme: "google-pubsub",
      config: { audience: PUBSUB_AUD, serviceAccountEmail: PUBSUB_SA },
    });
    await assert.rejects(() => webhooks.rotate(trigger.id), /source_has_no_secret/);
  });

  it("runs a flow the delivering replica never hydrated", async () => {
    // The queue hands a delivery to whichever replica is free, and that one's
    // boot-time flow map holds only what existed when it started. Without a
    // read-through the run dies as flow_not_found on a flow that plainly
    // exists — which is exactly what a live two-replica run produced.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const model = new MemoryModelProvider();

    const saved = new Map<string, FlowDefinition>();
    const sharedStore: FlowStore = {
      name: "shared",
      save: async (def) => {
        saved.set(def.id, def);
      },
      remove: async (id) => {
        saved.delete(id);
      },
      list: async () => [...saved.values()],
      get: async (id) => saved.get(id) ?? null,
      appendRun: async () => {},
      recentRuns: async () => [],
      close: async () => {},
    };

    // Replica A saves the flow.
    const flowsA = createFlowsSurface({ runtime, model, store: sharedStore });
    const def = flow("late-flow", "Late").model("s", { prompt: "{{input}}" }).build();
    await flowsA.save({ ...def, trigger: "webhook" });

    // Replica B booted earlier: it hydrated nothing and never sees the save.
    const flowsB = createFlowsSurface({ runtime, model, store: sharedStore });
    assert.equal((await flowsB.list()).length, 0, "B's map is empty by construction");

    const jobs: WebhookJob[] = [];
    const webhooksB = createWebhookSurface({
      runtime,
      flows: flowsB,
      store: createMemoryWebhookStore(),
      enqueue: async (job) => {
        jobs.push(job);
      },
    });
    // Registering has to see the flow too, or a hook could never be attached
    // from a replica that booted first.
    const { trigger, secret } = await createSigned(webhooksB, { flowId: "late-flow" });
    const accepted = await deliver(webhooksB, trigger.id, secret);
    assert.equal(accepted.ok && accepted.status, 202);

    const result = await webhooksB.deliver(jobs[0]!);
    assert.equal(result?.status, "completed");
    assert.equal(result?.flowId, "late-flow");
  });

  it("forgets a removed trigger", async () => {
    const { webhooks } = await makeSurface();
    const { trigger, secret } = await createSigned(webhooks, { flowId: "pr-triage" });
    assert.equal(await webhooks.remove(trigger.id), true);
    assert.equal(webhooks.list().length, 0);
    assert.deepEqual(await deliver(webhooks, trigger.id, secret), {
      ok: false,
      status: 404,
      error: "webhook_trigger_not_found",
    });
    assert.equal(await webhooks.remove(trigger.id), false);
  });
});

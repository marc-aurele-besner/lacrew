import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeEventSources,
  eventSelected,
  getEventSource,
  isEventSource,
} from "./eventSources.js";

function headers(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name.toLowerCase()];
}

function ctx(rawBody: string, map: Record<string, string> = {}) {
  return { rawBody, header: headers(map) };
}

/** A Pub/Sub push envelope carrying `payload` as base64 JSON. */
function pubsubEnvelope(payload: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString("base64"),
      messageId: "msg-1",
      publishTime: "2026-07-30T12:00:00Z",
      ...extra,
    },
    subscription: "projects/p/subscriptions/s",
  });
}

describe("event source registry", () => {
  it("knows only the sources it can verify", () => {
    assert.equal(isEventSource("lacrew"), true);
    assert.equal(isEventSource("github"), true);
    assert.equal(isEventSource("google-pubsub"), true);
    assert.equal(isEventSource("stripe"), false);
  });

  it("describes each source without leaking a secret or a config value", () => {
    const described = describeEventSources();
    assert.equal(described.length, 3);
    const pubsub = described.find((s) => s.id === "google-pubsub")!;
    assert.equal(pubsub.usesSecret, false);
    assert.deepEqual(pubsub.requiredConfig, ["audience", "serviceAccountEmail"]);
    const github = described.find((s) => s.id === "github")!;
    assert.equal(github.usesSecret, true);
    assert.equal(github.signatureHeader, "x-hub-signature-256");
    assert.ok(!JSON.stringify(described).includes("secret\":\""));
  });
});

describe("github event source", () => {
  const github = getEventSource("github");

  it("composes the event type from the header and the body action", () => {
    // GitHub splits it: the header names the event, the body names the action.
    const body = { action: "opened", pull_request: { number: 7 } };
    assert.equal(
      github.eventType(ctx("{}", { "x-github-event": "pull_request" }), body),
      "pull_request.opened",
    );
  });

  it("falls back to the bare event when the body carries no action", () => {
    assert.equal(github.eventType(ctx("{}", { "x-github-event": "push" }), { ref: "refs/heads/main" }), "push");
  });

  it("takes X-GitHub-Delivery as the idempotency key", () => {
    assert.equal(github.deliveryKey(ctx("{}", { "x-github-delivery": "gh-1" }), {}), "gh-1");
    assert.equal(github.deliveryKey(ctx("{}"), {}), undefined);
  });

  it("passes the body through untouched as the flow payload", () => {
    const body = { action: "closed" };
    assert.equal(github.payload(ctx("{}"), body), body);
  });
});

describe("google pub/sub event source", () => {
  const pubsub = getEventSource("google-pubsub");

  it("unwraps the base64 envelope so a mapping sees the real message", () => {
    // The whole point: mapping `emailAddress` against the envelope would read
    // nothing and look like a typo rather than an unreachable path.
    const raw = pubsubEnvelope({ emailAddress: "ops@example.com", historyId: 9915 });
    const payload = pubsub.payload(ctx(raw), JSON.parse(raw));
    assert.deepEqual(payload, { emailAddress: "ops@example.com", historyId: 9915 });
  });

  it("hands back text plus metadata when the message is not JSON", () => {
    const raw = JSON.stringify({
      message: {
        data: Buffer.from("plain alert").toString("base64"),
        messageId: "msg-2",
        attributes: { eventType: "alert" },
      },
    });
    assert.deepEqual(pubsub.payload(ctx(raw), JSON.parse(raw)), {
      text: "plain alert",
      attributes: { eventType: "alert" },
    });
  });

  it("reports a malformed envelope rather than mapping against nothing", () => {
    assert.equal(pubsub.payload(ctx("{}"), {}), undefined);
    assert.equal(pubsub.payload(ctx("[]"), []), undefined);
  });

  it("takes the Pub/Sub messageId as the idempotency key", () => {
    const raw = pubsubEnvelope({ a: 1 });
    assert.equal(pubsub.deliveryKey(ctx(raw), JSON.parse(raw)), "msg-1");
    // Pub/Sub's REST shape uses snake_case; both spellings appear in the wild.
    const snake = JSON.stringify({ message: { message_id: "msg-3", data: "e30=" } });
    assert.equal(pubsub.deliveryKey(ctx(snake), JSON.parse(snake)), "msg-3");
  });

  it("reads the event type from message attributes", () => {
    const raw = pubsubEnvelope({ a: 1 }, { attributes: { eventType: "mail.received" } });
    assert.equal(pubsub.eventType(ctx(raw), JSON.parse(raw)), "mail.received");
    const bare = pubsubEnvelope({ a: 1 });
    assert.equal(pubsub.eventType(ctx(bare), JSON.parse(bare)), undefined);
  });

  it("refuses to verify without the audience and service account bindings", async () => {
    // Without them a valid Google signature proves only that *somebody* has a
    // Google project, which is not an authorization to start a funded flow.
    assert.deepEqual(
      await pubsub.verify({ ctx: ctx("{}"), secret: undefined, config: {} }),
      { ok: false, reason: "source_config_missing" },
    );
    assert.deepEqual(
      await pubsub.verify({
        ctx: ctx("{}"),
        secret: undefined,
        config: { audience: "https://x.example" },
      }),
      { ok: false, reason: "source_config_missing" },
    );
  });
});

describe("event selection", () => {
  it("passes everything when no filter is set", () => {
    assert.equal(eventSelected(undefined, "pull_request.opened"), true);
    assert.equal(eventSelected([], "pull_request.opened"), true);
  });

  it("matches an exact type and a dotted prefix", () => {
    assert.equal(eventSelected(["pull_request"], "pull_request.opened"), true);
    assert.equal(eventSelected(["pull_request.opened"], "pull_request.opened"), true);
    assert.equal(eventSelected(["push", "release"], "release.published"), true);
  });

  it("does not let a broad delivery satisfy a narrow filter", () => {
    // Subscribing to `pull_request.opened` must not admit every pull_request
    // event; prefix matching runs one way only.
    assert.equal(eventSelected(["pull_request.opened"], "pull_request"), false);
    assert.equal(eventSelected(["pull_request"], "issues.opened"), false);
    assert.equal(eventSelected(["pull_request"], "pull_request_review.submitted"), false);
  });

  it("passes a delivery whose type the provider never declared", () => {
    // "I could not tell what this was" is not "you did not ask for this", and
    // silently dropping events from an unlabelled topic would be worse.
    assert.equal(eventSelected(["mail.received"], undefined), true);
  });
});

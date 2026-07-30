import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isFlowWaiting } from "@lacrew/flows";
import type { ProtocolEvent } from "@lacrew/core";
import {
  askFingerprint,
  createConnectorAsks,
  readAskAnswer,
  type ConnectorAskRecord,
} from "./connectorAsks.js";
import { normalizeMessage, type Message } from "./conversation.js";

const PRINCIPAL = "0x00000000000000000000000000000000000000a1";

/** A conversation stub that stores what it was asked to post. */
function fakeThread() {
  const posted: Message[] = [];
  let seq = 0;
  const postQuestion = (input: {
    threadId: string;
    author: string;
    body: string;
    options: string[];
  }): Message => {
    seq += 1;
    const message = normalizeMessage(
      {
        scope: { kind: "agent", account: input.author },
        author: input.author,
        authorKind: "agent",
        kind: "question",
        body: input.body,
        options: input.options,
      },
      `msg_${seq}`,
      new Date(2026, 0, 1, 12, seq).toISOString(),
    );
    posted.push(message);
    return message;
  };
  return { posted, postQuestion };
}

function answer(question: Message, body: string, at = "2026-01-01T13:00:00.000Z"): Message {
  return normalizeMessage(
    {
      scope: { kind: "agent", account: PRINCIPAL },
      author: "human:ops",
      authorKind: "human",
      kind: "answer",
      body,
      replyTo: question.id,
    },
    `${question.id}_answer`,
    at,
  );
}

const request = {
  connector: "github",
  route: "merge_pull_request",
  method: "PUT",
  path: "/repos/acme/site/pulls/7/merge",
  args: { merge_method: "squash" },
  principal: PRINCIPAL,
  flowId: "pr-triage",
  runId: "run-1",
};

test("the first ask posts a question and suspends the run", async () => {
  const thread = fakeThread();
  const events: ProtocolEvent[] = [];
  const asks = createConnectorAsks({
    postQuestion: thread.postQuestion,
    onEvent: (e) => events.push(e),
  });

  await assert.rejects(
    () => asks.gate(request),
    (err: unknown) => isFlowWaiting(err) && err.reason === "connector_ask",
  );

  assert.equal(thread.posted.length, 1);
  const question = thread.posted[0]!;
  assert.equal(question.kind, "question");
  assert.deepEqual(question.options, ["yes", "no"]);
  assert.match(question.body, /merge_pull_request/);
  assert.match(question.body, /\/repos\/acme\/site\/pulls\/7\/merge/);
  assert.match(question.body, /approves no spend/, "the copy must not read as an approval");

  const ask = asks.list()[0]!;
  assert.equal(ask.status, "pending");
  assert.equal(ask.questionId, question.id);
  assert.equal(events[0]?.type, "ConnectorAsk");
  assert.equal(
    (events[0]?.payload as Record<string, unknown>).args,
    undefined,
    "the trail carries the fingerprint, never the arguments",
  );
});

test("asking again while pending re-suspends without a second question", async () => {
  const thread = fakeThread();
  const asks = createConnectorAsks({ postQuestion: thread.postQuestion });
  await assert.rejects(() => asks.gate(request), isFlowWaiting);
  await assert.rejects(() => asks.gate(request), isFlowWaiting);
  assert.equal(thread.posted.length, 1);
  assert.equal(asks.list().length, 1);
});

test("yes releases the call exactly once", async () => {
  const thread = fakeThread();
  const asks = createConnectorAsks({ postQuestion: thread.postQuestion });
  await assert.rejects(() => asks.gate(request), isFlowWaiting);

  asks.observe(answer(thread.posted[0]!, "yes"));
  assert.equal(asks.list()[0]!.status, "approved");

  // The call goes out: the gate returns instead of throwing.
  await asks.gate(request);
  assert.equal(asks.list()[0]!.status, "consumed");

  // A second attempt on the same yes is refused, not called.
  await assert.rejects(() => asks.gate(request), /connector_ask_spent/);
});

test("no refuses the step and never becomes a yes", async () => {
  const thread = fakeThread();
  const asks = createConnectorAsks({ postQuestion: thread.postQuestion });
  await assert.rejects(() => asks.gate(request), isFlowWaiting);
  asks.observe(answer(thread.posted[0]!, "No."));
  await assert.rejects(() => asks.gate(request), /connector_ask_declined/);
});

test("free text resolves nothing and the question is re-posted", async () => {
  const thread = fakeThread();
  const events: ProtocolEvent[] = [];
  const asks = createConnectorAsks({
    postQuestion: thread.postQuestion,
    onEvent: (e) => events.push(e),
  });
  await assert.rejects(() => asks.gate(request), isFlowWaiting);

  asks.observe(answer(thread.posted[0]!, "sure, go ahead and merge it"));
  assert.equal(asks.list()[0]!.status, "pending", "an ambiguous reply is not a yes");
  assert.equal(thread.posted.length, 2, "the question is asked again so the queue stays honest");
  assert.equal(asks.list()[0]!.questionId, thread.posted[1]!.id);
  assert.ok(events.some((e) => e.type === "ConnectorAskUnresolved"));

  // The re-posted question is the one that now resolves it.
  asks.observe(answer(thread.posted[1]!, "yes"));
  assert.equal(asks.list()[0]!.status, "approved");
});

test("an answer to somebody else's question resolves nothing", async () => {
  const thread = fakeThread();
  const asks = createConnectorAsks({ postQuestion: thread.postQuestion });
  await assert.rejects(() => asks.gate(request), isFlowWaiting);

  const stray = normalizeMessage(
    {
      scope: { kind: "agent", account: PRINCIPAL },
      author: "human:ops",
      authorKind: "human",
      kind: "answer",
      body: "yes",
      replyTo: "msg_does_not_exist",
    },
    "msg_stray",
    "2026-01-01T13:00:00.000Z",
  );
  asks.observe(stray);
  assert.equal(asks.list()[0]!.status, "pending");
});

test("a yes covers one request, not a different one", async () => {
  const thread = fakeThread();
  const asks = createConnectorAsks({ postQuestion: thread.postQuestion });
  await assert.rejects(() => asks.gate(request), isFlowWaiting);
  asks.observe(answer(thread.posted[0]!, "yes"));

  // Same route, same run, different pull request: a new ask and a new question.
  const other = { ...request, path: "/repos/acme/site/pulls/9/merge" };
  await assert.rejects(() => asks.gate(other), isFlowWaiting);
  assert.equal(thread.posted.length, 2);
  assert.equal(asks.list().length, 2);

  // And a changed argument is a different request too.
  const changedArgs = { ...request, args: { merge_method: "merge" } };
  await assert.rejects(() => asks.gate(changedArgs), isFlowWaiting);
  assert.equal(asks.list().length, 3);
});

test("an unanswered ask expires and the step fails closed", async () => {
  const thread = fakeThread();
  const events: ProtocolEvent[] = [];
  let clock = new Date("2026-01-01T12:00:00.000Z");
  const asks = createConnectorAsks({
    postQuestion: thread.postQuestion,
    onEvent: (e) => events.push(e),
    ttlMs: 60_000,
    now: () => clock,
  });
  await assert.rejects(() => asks.gate(request), isFlowWaiting);

  clock = new Date("2026-01-01T12:02:00.000Z");
  const expired = await asks.sweep();
  assert.equal(expired.length, 1);
  assert.equal(asks.list()[0]!.outcome, "expired");
  assert.ok(
    events.some(
      (e) =>
        e.type === "ConnectorAskResolved" &&
        (e.payload as Record<string, unknown>).outcome === "expired",
    ),
  );

  await assert.rejects(() => asks.gate(request), /connector_ask_timeout/);
});

test("a yes that lands before the run finished suspending still resumes it", async () => {
  const thread = fakeThread();
  const asks = createConnectorAsks({ postQuestion: thread.postQuestion });
  const resumed: ConnectorAskRecord[] = [];
  asks.setResumer(async (ask) => {
    resumed.push(ask);
  });

  await assert.rejects(() => asks.gate(request), isFlowWaiting);
  const id = asks.list()[0]!.id;
  // The human answers before `runFlow` has returned its resume state.
  asks.observe(answer(thread.posted[0]!, "yes"));
  assert.equal(resumed.length, 0, "nothing to resume yet");

  await asks.attachResume(id, { stepId: "merge", outputs: {}, steps: [] });
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.id, id);
});

test("asks survive a restart, including the spent ones", async () => {
  const rows = new Map<string, ConnectorAskRecord>();
  const store = {
    loadConnectorAsks: async () => [...rows.values()],
    saveConnectorAsk: async (record: ConnectorAskRecord) => {
      rows.set(record.id, structuredClone(record));
    },
  };
  const first = createConnectorAsks({ postQuestion: fakeThread().postQuestion, store });
  await assert.rejects(() => first.gate(request), isFlowWaiting);
  const question = first.list()[0]!.questionId;
  first.observe(answer({ id: question } as Message, "yes"));
  await first.gate(request);

  const second = createConnectorAsks({ postQuestion: fakeThread().postQuestion, store });
  assert.equal(await second.hydrate(), 1);
  await assert.rejects(
    () => second.gate(request),
    /connector_ask_spent/,
    "a confirmation already spent must not be spendable again after a restart",
  );
});

test("only the offered options read as a decision", () => {
  assert.equal(readAskAnswer(" YES "), "approved");
  assert.equal(readAskAnswer("no!"), "declined");
  assert.equal(readAskAnswer("yes please"), null);
  assert.equal(readAskAnswer("approve 500 USDC"), null);
});

test("the fingerprint ignores argument order and nothing else", () => {
  const a = askFingerprint({ method: "PUT", path: "/x", args: { b: 2, a: 1 } });
  const b = askFingerprint({ method: "PUT", path: "/x", args: { a: 1, b: 2 } });
  assert.equal(a, b);
  assert.notEqual(a, askFingerprint({ method: "PUT", path: "/x", args: { a: 1, b: 3 } }));
  assert.notEqual(a, askFingerprint({ method: "PUT", path: "/y", args: { a: 1, b: 2 } }));
  assert.notEqual(a, askFingerprint({ method: "POST", path: "/x", args: { a: 1, b: 2 } }));
});

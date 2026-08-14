---
title: "Supervising a crew from chat"
---

A crew that asks a question stops. Until someone answers it, nothing moves — which is
correct, and useless if the only place the question is visible is a browser tab nobody has
open at 03:00.

The chat bridge closes that gap in both directions: an open question produces a
notification in Slack or Telegram, and a reply in that channel lands as an `answer` in the
thread the question was asked in.

## What a chat message can and cannot do

**A message is a claim, never an authority.** This is the same rule the conversation
surface has always held, and chat is where it matters most: there is no session behind a
Telegram message, and anyone in a shared group can type.

So the bridge produces exactly two kinds:

| Kind     | When                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `answer` | A reply to a question that is still open, in the thread that asked it.                                                         |
| `note`   | Everything else — a reply to a plan, a second opinion on a closed question, a message from a room an operator bound to a crew. |

It cannot produce a `plan`, a `result` or a `handoff`, and it never calls `approve`,
`deny`, `vote`, `veto` or `execute`. "approve 500 USDC" typed into a chat is a sentence in
a thread; the intent it names is still in Approvals, untouched, waiting for a seat that can
actually approve it. The bot says so when it sees text shaped like an instruction —
`authorityHint` in `@lacrew/orchestrator` — because a sender who reads "Posted your
answer" after typing that has every reason to believe the money moved.

## Correlation tokens

A reply has to reach the message it answers, and the inbound path has no session to check
a claimed thread id against. So the id travels as a token this deployment signed:

```
lc1.<base64url(thread|messageId|issuedAtSeconds)>.<hmac-sha256, 128 bits>
```

It is minted with `mintCorrelation`, rendered into the outbound alert by
`correlationFooter`, and read back with `correlationIn` + `verifyCorrelation`. Properties
worth stating plainly:

- **A sender cannot mint one.** Editing the payload to name another thread changes the
  signature, and the signature is checked before the payload is parsed.
- **It proves _which thread_, not _who_.** Pairing (F2.20) still decides whether this
  person may write there. Both must pass.
- **It expires** after 14 days (`CORRELATION_TTL_MS`), so an old chat log is not a set of
  live write handles. The question is not lost — it is still in the Questions rail.
- **The signing key is the deployment's**, never a bot token. Rotating a Telegram
  credential does not invalidate every question already asked.

## Resolution

`readInboundCommand` parses the text; `resolveInbound` decides. Both are pure, both live in
`@lacrew/orchestrator`, and the hosted control plane calls them rather than re-deriving the
rules — a self-hoster can read the rule that is actually being applied.

| Situation                                         | Result                           |
| ------------------------------------------------- | -------------------------------- |
| Reply to an open question                         | `answer`, `replyTo` the question |
| Reply to a question someone already answered      | `note`, still referencing it     |
| Reply to a plan or a note                         | `note`, referencing it           |
| `/note …` with a reference                        | `note`                           |
| `/answer …` with nothing to answer                | refused                          |
| No token, room bound to a crew                    | `note` in that crew's thread     |
| No token, room not bound                          | refused                          |
| Token this deployment did not sign                | refused, and no thread is read   |
| Token naming a message that is not in that thread | refused                          |

Refusals never name a thread the sender did not already hold a token for, and never
distinguish "not yours" from "does not exist" — an endpoint anyone can message must not
answer questions about a workspace's shape.

## Why a binding, and not a guess

A message with no token still has to go somewhere, and the tempting answer — infer the
crew from the room — is how a stray sentence ends up in a funded crew's history. Instead a
room reaches a thread only when an operator bound it, in the app, with a session. Unbound
rooms can still answer questions, because the token carries its own target; they simply
cannot start something.

A binding is routing, never permission. An unpaired sender in a bound room is refused
exactly as before.

## Operator setup

1. **Mint the delivery endpoint** (Settings → Channel access). The secret is shown once.
2. **Register it with the platform.** For Telegram, pass the secret as `secret_token` to
   `setWebhook`. For Slack, the URL is the Events request URL and the proof is the app's
   signing secret, stored with the other channel credentials; subscribe the app to
   `app_mention` (channels) and `message.im` (direct messages).
3. **Store a bot credential**, so the bot can answer in the room rather than only in the
   HTTP response nobody in the room reads. Telegram: the bot token. Slack: a bot token
   (`xoxb-…`) — **not** the incoming webhook the alerts go out on, which posts to the one
   channel it was minted for and so cannot answer the room that wrote. Slack scopes:
   `chat:write` to answer, `channels:join` to let it join a public channel it was never
   invited to, `users:read` to show a paired person by name instead of by id.
4. **Pair your account** — send `pair <code>` to the bot from the account you want to speak
   from. The code binds to your seat, expires in ten minutes, and works once.
5. **Set a channel signing key** on the control plane: `LACREW_CHANNEL_SECRET`, or
   `LACREW_SESSION_KEY` (from which one is derived). Without it there is no verifiable
   reply target and the bridge stays off rather than trusting.
6. **Optionally bind a room to a crew**, so messages nobody was asked for have a home.

## Acknowledgement

`acknowledgement` in `@lacrew/orchestrator` is the text the bot sends back — it names the
kind and the thread and stops there, because anything warmer would let a sender read a
thread post as an outcome. Where that text appears depends on the credential:

| Stored                       | Where the sender sees it                                           |
| ---------------------------- | ------------------------------------------------------------------ |
| A bot token for the platform | In the room they wrote from — in the thread, on Slack in a channel |
| Nothing                      | The endpoint's HTTP response only, which nobody in the room reads  |

**A failed acknowledgement never undoes the thread post.** The claim has already landed;
losing the receipt is the smaller failure, and re-posting it because the platform retried
the delivery would be the larger one. The endpoint's response reports the delivery and the
platform's own reason for refusing it. On Slack, `not_in_channel` means the bot is not a
member of the channel it is answering in: it tries to join once (public channels only) and
posts again, and what survives that is an invite a human has to send.

## Retries

Both platforms redeliver a message the endpoint did not answer quickly enough — Slack after
three seconds, several times. The endpoint reads a thread and posts to it before it
answers, so a delivery is remembered by the platform's own id (`event_id`, `update_id`) and
a repeat is refused with `duplicate`. Without that, one reply becomes two identical answers
in a crew's thread, which nobody can tell apart from someone saying it twice.

## Known limits

- **Telegram is the certified channel**, in the sense that its whole path has been driven
  live end to end. Slack's inbound path is route-tested against a mocked Web API.
- **Retry memory is per replica**, like the rate limits. Two replicas can each act on one
  copy of a retry; one replica cannot act on it twice.
- **Discord is out**, as in F2.20: its bots receive over a gateway connection, not an HTTP
  webhook, so there is no URL to point at a control plane.
- Rate limits on the inbound path are per replica, not distributed.

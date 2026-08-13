---
title: Notifications
description: Reach a person who isn't watching — permission requests, finished turns, errors and closes, POSTed to a webhook.
order: 5
---

A session that needs an approval is useless if nobody is looking at it. The session WebSocket is
the live channel, but it only helps someone with a socket open — and a phone cannot hold one in
the background. Session notifications are the way out: the server reaches *you*.

Four moments, chosen because they are the ones a person acts on:

| Type | When |
| --- | --- |
| `permission_requested` | The agent is blocked on an approval. |
| `turn_completed` | A turn finished; the session is idle and waiting. |
| `session_error` | The session failed. |
| `session_closed` | The session ended, whoever ended it. |

This is a human-attention channel, not an event mirror. Everything else stays on the session WS
— attach with `afterSeq` to catch up on what you missed.

## Enabling

```ts
const worker = createWorkerServer({
  authenticate,
  notifications: {
    webhook: {
      url: 'https://my-app.test/hooks/session',
      headers: { authorization: '…' },
      events: ['permission_requested', 'session_error'], // default: all four
    },
    // In-process seam, unfiltered — fires whether or not a webhook is configured.
    onNotification: (n) => console.log(n.type, n.sessionId, n.preview),
  },
})
```

The config is **server-wide**, unlike the [job queue](/workerdeck/docs/guides/job-queue/)'s
per-job `webhook` — the whole point is hearing about sessions you did not create and are not
attached to. Every registry session qualifies, job runs included, so a job carrying its own
webhook is reported on both channels.

## The payload

```jsonc
{
  "type": "permission_requested",
  "sessionId": "sess_…",
  "seq": 42,                  // attach with afterSeq: 41 to land on the event behind it
  "ts": 1767225600000,
  "preview": "Bash",          // one line fit for a notification body
  "session": { /* SessionInfo as the event left it — status, title, cwd, cost */ },
  "request": { /* the full PermissionRequest */ }
}
```

`request` rides along on `permission_requested` for one reason: with the request id in hand a
consumer can answer over REST —

```http
POST /v1/sessions/:sessionId/permissions/:requestId
{ "behavior": "allow" }
```

— which is what makes an Approve/Deny action on a lock-screen notification, or a button in a
Slack message, work at all. See [Permissions](/workerdeck/docs/guides/permissions/).

`turn_completed` carries `result` (`isError`, `durationMs`, `numTurns`, `totalCostUsd`);
`session_closed` carries `reason`.

## Delivery

Ordered per session, best-effort, retried with exponential backoff (`attempts`, default 3;
`retryDelayMs`, default 500). A consumer that missed one can always attach to the session WS and
read the truth — deliveries are a prompt, never the system of record.

## Push notifications

The server holds no push credentials, by design: it speaks HTTP to a URL you control and knows
nothing about APNs, FCM, Slack or email. Turning a notification into a phone push is a
forwarder's job — it needs credentials, and those belong to whatever you run in front of, or
alongside, the gateway.

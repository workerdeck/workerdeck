# @workerdeck/client

Typed WorkerDeck protocol client for browsers and Node: REST session management plus a
WebSocket attach with auto-reconnect and replay-from-last-seq. Uses the platform's `fetch` and
`WebSocket`; zero runtime dependencies beyond the wire types.

Part of [WorkerDeck](https://github.com/workerdeck/workerdeck). It speaks the
[`@workerdeck/protocol`](https://www.npmjs.com/package/@workerdeck/protocol) wire format to a
running [`@workerdeck/server`](https://www.npmjs.com/package/@workerdeck/server) gateway.
Layers above build on it:
[`@workerdeck/react`](https://www.npmjs.com/package/@workerdeck/react) (headless hook +
transcript reducer) and [`@workerdeck/ui`](https://www.npmjs.com/package/@workerdeck/ui)
(styled session panel).

## Install

```bash
npm install @workerdeck/client
```

Pairs with a running `@workerdeck/server` — the client is just the typed caller.

## Usage

```ts
import { WorkerDeckClient } from '@workerdeck/client'

const client = new WorkerDeckClient({
  baseUrl: 'http://127.0.0.1:8787/v1', // ws:// URL is derived from it
  headers: { authorization: 'Bearer …' }, // REST auth; use buildWsUrl/cookies for WS auth
})

const session = await client.createSession({
  cwd: '/srv/checkouts/my-repo',
  prompt: '/verify-content 42',
  settingSources: ['user', 'project'],
})

const handle = client.attach(session.id) // auto-reconnects, replays from last seen seq
handle.on('attached', (frame) => console.log('snapshot', frame.session.status))
handle.on('event', (event) => console.log(event.seq, event.type))
handle.on('connectionChange', (up) => console.log(up ? 'connected' : 'reconnecting'))

handle.send('also run the tests')
handle.approve(requestId)                // permission decisions
handle.deny(requestId, 'not this file')
handle.interrupt()
handle.setPermissionMode('acceptEdits')
handle.detach()                          // disconnect without touching the session
```

`attach()` accepts `{ afterSeq, reconnect }`. On reconnect the handle asks the server for events
after the last seq it saw, so the stream is gapless and duplicates are dropped; commands sent
while disconnected are buffered and flushed on reopen. REST surface:
`createSession` / `listSessions` / `getSession` / `deleteSession`, `resolvePermission` (answer a
pending approval or `AskUserQuestion` over REST), and `listSdkSessions` (on-disk sessions to feed
`createSession({ resume })`).

### Job queue

Against a server configured with `queue`:

```ts
const job = await client.createJob({
  session: { cwd: '/srv/checkout', prompt: '/verify-content 42' },
  webhook: { url: 'https://my-app.test/hooks/claude' },
  attempts: 3,
})
await client.getJob(job.id)      // plus listJobs(), cancelJob(id), queueStats()

const queue = client.attachQueue() // read-only live stream over /queue/ws
queue.on('event', (e) => console.log(e.type, e.job.id))
queue.on('stats', (s) => console.log(s.running, 'running of', s.maxConcurrency))
```

The queue stream has no replay: on (re)connect, re-list jobs and treat the stream as updates.

## Runtime

- **Browsers and Node** — built on platform `fetch` and `WebSocket` (global in Node ≥22). Both are
  injectable (`fetchImpl`, `WebSocketImpl`) for older runtimes, polyfills, and tests.
- **Zero runtime dependencies** — the only dependency is `@workerdeck/protocol`, which is
  itself dependency-free wire types.
- Browsers cannot set WS headers: authenticate the socket with a ticket query param via
  `buildWsUrl(sessionId, afterSeq)` (and `buildQueueWsUrl`) or with cookies.

## Rules you cannot infer from the types

- **`truncateResults` is for renderers only.** It asks the gateway to replay an oversized
  `tool_result` as its *head*, with `truncated`/`total_chars` set and the rest available from
  `client.toolResult(...)`. Ask for it only if you also fetch it back — otherwise you will show a
  head as though it were the whole result, which is the one failure this option is designed to
  avoid. `@workerdeck/react`'s `useClaudeSession` sets it; nothing else in this package does, and
  the default must stay off.

- **`imageRefs` is the same bargain, for pictures.** It asks the gateway to replay a
  `tool_result`'s base64 image parts as `image_ref` addresses — media type, decoded size, and the
  part's index in the stored block — with the bytes available from `client.toolResultImage(...)`.
  Measured across 214 local sessions this is **91% of all tool-result payload and none of what any
  client drew**: one session's attach falls from 4,548 KB to 1,275 KB, and a session with no
  pictures in it is byte-identical. Renderers only, same reason, same default. It is deliberately a
  **separate flag** from `truncateResults` rather than a widening of it, and it is the one option
  here that also applies to **live** events — the render path is ref-then-fetch, so bytes arriving
  live would only be discarded or pinned in client state.

- **One client per gateway.** Session ids are unique within a gateway, not across them; two
  clients for one gateway means two of everything that is meant to be shared.
- **A refused call throws `WorkerDeckError`, and its `status` is the useful part.** 404 means this
  gateway has no such route — stop asking, disable the feature — while 413 means that one file was
  too big. Collapsing them into "request failed" is how a client ends up polling a route that will
  never exist.
- **Browsers cannot header a WebSocket upgrade.** Same-origin gateways authenticate the socket
  with the login cookie; a gateway on another origin needs the key in the query string
  (`hostAuth()` builds both forms), and its REST calls additionally need the gateway to run with
  `--cors-origin`.
- **`apiUrl`/`isLoopbackHost` decide from the URL, never by probing.** What the operator typed
  becomes a `baseUrl` by one rule, in one place — because the same gateway normalised two ways is
  two gateways, with two sets of unread marks.

## License

MIT © Tobias Strebitzer — see
[LICENSE](https://github.com/workerdeck/workerdeck/blob/master/LICENSE).

# @workerdeck/react

Headless React layer for WorkerDeck: the `useClaudeSession` hook plus a pure transcript
reducer. No styling opinion — bring your own rendering, or use
[`@workerdeck/ui`](https://www.npmjs.com/package/@workerdeck/ui), the styled layer on top.

Part of [WorkerDeck](https://github.com/workerdeck/workerdeck). It sits between
[`@workerdeck/client`](https://www.npmjs.com/package/@workerdeck/client) (REST + WebSocket
attach) and your components: the hook attaches to a session, folds the event stream through the
reducer, and hands back live state plus the control surface (send, approve/deny, interrupt,
permission mode, model).

## Install

```bash
npm install @workerdeck/react @workerdeck/client
```

`react` is a peer dependency (`^18 || ^19`).

## Usage

```tsx
import { WorkerDeckClient } from '@workerdeck/client'
import { useClaudeSession } from '@workerdeck/react'

const client = new WorkerDeckClient({ baseUrl: 'http://127.0.0.1:8787/v1' })

function Panel({ sessionId }: { sessionId: string }) {
  const { state, connected, send, approve, deny, interrupt } = useClaudeSession(client, sessionId)

  return (
    <div>
      <header>{state.status} {state.model} {connected ? '' : '(reconnecting)'}</header>
      {state.items.map((item) =>
        item.kind === 'assistant_text' ? <p key={item.id}>{item.text}</p> : null,
      )}
      {state.pendingApprovals.map((req) => (
        <div key={req.id}>
          {req.toolName}
          <button onClick={() => approve(req.id)}>Allow</button>
          <button onClick={() => deny(req.id)}>Deny</button>
        </div>
      ))}
      <input onKeyDown={(e) => e.key === 'Enter' && send(e.currentTarget.value)} />
    </div>
  )
}
```

The hook attaches on mount, detaches on unmount, and survives reconnects — the underlying handle
replays from the last seen seq, and the reducer ignores anything it has already applied.

### The transcript reducer, standalone

The state machine is framework-free and exported directly — usable in tests, workers, or any
non-React consumer of the event stream:

```ts
import { applyEvent, initialTranscriptState, seedFromSessionInfo } from '@workerdeck/react'

let state = initialTranscriptState
state = seedFromSessionInfo(state, sessionInfo) // optional: seed from the attach snapshot
for (const event of events) state = applyEvent(state, event)
```

`seedFromSessionInfo` fills fields (status, model, permission mode) a promptless session's event
stream doesn't carry yet; events stay authoritative once they arrive.

## What the state contains

`TranscriptState` is everything a session panel needs to render:

- `items` — the ordered transcript: `user`, `assistant_text` (with a `streaming` flag),
  `thinking`, `tool_call` (input + eventual result), `turn_result`, and `notice` items.
  Streaming deltas accumulate in-place and are superseded by the full assistant message.
- `pendingApprovals` — permission requests awaiting an approve/deny decision.
- `status` / `statusDetail`, `model`, `cwd`, `sdkSessionId`, `permissionMode`.
- `models` and `commands` — what the session can switch to / accepts (from `capabilities`).
- `capabilities` — **the engine's capability record**, always present: the runner-reported copy
  from the attach snapshot, else the protocol's static default for the engine. Render affordances
  from this rather than switching on the engine name; an absent capability means the control is
  *hidden*, never one that silently does nothing.
- `session` — the whole attach snapshot, for the facts no event carries (profile, `apiKeySource`,
  `canBypassPermissions`, `createdAt`).
- `contextUsage`, `rateLimits` (keyed by window; absent for API-key sessions — render nothing,
  not 0%) with `rateLimitsUpdatedAt`, `totalCostUsd` (session-cumulative), and `lastSeq` for
  replay dedupe.

The reducer is pure and immutable: same events in, same state out — which is also how it is
unit-tested. Keep rendering logic out of it. `rateLimitWindows(state)` and `scanPromptTokens(text)`
are the other pure helpers here, for the same reason: ordered usage windows and `@file` /
`/command` token recognition are string-and-shape work every client needs and every client should
agree on.

## Composing a message

Two more hooks cover what a composer needs beyond text, both capability-aware:

```tsx
const { state, send } = useClaudeSession(client, sessionId)
// Staging + upload, filtered by `capabilities.attachments`: a kind the engine
// forswears is refused locally instead of 415'ing at the gateway.
const attachments = useAttachments(client, sessionId, {
  capabilities: state.capabilities,
  engine: state.engine,
})
// `@file` search rooted at the session's cwd. `available` is false when the
// gateway serves no host files — don't advertise what isn't there.
const files = useHostFileSearch(client, state.cwd)

attachments.add(pickedFiles) // uploads start immediately
send(text, attachments.readyIds) // the message names ids; bytes never enter the event log
```

## Running tool calls in the tab

A provider-engine session can ask the *browser* to execute a sandboxed tool call, so documents the
user holds locally never reach the server. `useToolCallHost` answers those requests from a mounted
component, running the code in a QuickJS guest
([`@workerdeck/sandbox`](https://www.npmjs.com/package/@workerdeck/sandbox), loaded on
demand):

```tsx
const { handle } = useClaudeSession(client, sessionId)
const { executions } = useToolCallHost(handle, {
  tools: ['eval_script'], // allowlist — anything else the server asks for is refused
  timeoutMs: 15_000,
  fetchText: (url) => myGatedFetch(url), // omit and the guest has no network at all
})
```

The host must ride **the hook's own `handle`** — the server bridges each call to the first attached
client, so a second, separately-created handle would sit idle while the real one gets the requests.
`createToolCallHost` is the same logic without React. Results returned from a tab are untrusted
input by construction: fine for the user's own data, never a source of server-authoritative state.

## Rules you cannot infer from the types

- **Companions must ride the hook's own `handle`.** The server's tool bridge asks the *first
  attached client*, so a second `useClaudeSession` for the same session is a second attach that
  will never be asked anything. `useAttachments`, `useHostFileSearch` and `useToolCallHost` all
  take the handle you already have.
- **`TranscriptState.capabilities` is always populated**, engine record or protocol default. Render
  every surface from it rather than branching on the engine name — that is what makes one component
  correct for all three engines.
- **`useToolCallHost` refuses tool names outside its allow-list** (default `['eval_script']`). It is
  a grant, not a filter: every name you add is one this tab will execute on the gateway's say-so.
- **`useOpenFiles` keeps `content` (disk) and `draft` (edits) apart, and `/fs/write` is conditional
  always.** A 409 is a *choice* to offer the user — reload, keep mine, dismiss — never a toast, and
  nothing but `revert` or an explicit reload may discard a draft.
- **The recap is counted, never written.** `summarizeSince` returns numbers because generating
  prose would spend a turn on a summary nobody asked for, and would be worst exactly where it
  matters most: a session that failed while unattended.

## License

MIT © Tobias Strebitzer — see
[LICENSE](https://github.com/workerdeck/workerdeck/blob/master/LICENSE).

---
title: Embed WorkerDeck in your app
description: Put a sandboxed agent inside your own product — gateway in your server, sessions owned by your users, your data reached over MCP.
order: 1
---

This is the guide for putting an agent **inside a product you already have**: your server, your
login, your users, your data. The agent is a feature of your app, not a tool your operators run.

If instead you want to point a UI at a gateway somebody else runs, you want
[Embedding the UI](/workerdeck/docs/guides/embedding/) — a different, smaller job.

The reference implementation for everything below is
[`apps/embedded`](https://github.com/workerdeck/workerdeck/tree/master/apps/embedded): a wiki SPA
whose right-hand rail is a sandboxed agent, with the gateway inside the app's own server. Every
step here is something it needed, in the order it needed it.

---

## 1. What you are building, and why it is one port

```
:PORT ─┬─ /v1/*   the WorkerDeck gateway: REST + the session WebSocket
       └─ everything else, through the gateway's `fallback`:
          ├─ /api/*  your app's own API
          ├─ /mcp    your data, as an MCP server, for the agent only
          └─ /*      your SPA
```

Decide this first, because it determines the whole layout: **the gateway and your app must share
an origin.**

The tab drives a session over a WebSocket. A browser cannot put an `Authorization` header on a
WebSocket upgrade — the API simply has no such argument — so the only credential a tab can present
on an attach is a cookie, and a cookie is per-origin. Put the gateway on `:8081` and your app's
login stops authenticating the agent socket.

So the gateway takes the port and everything else rides its `fallback`. Nothing is proxied, and
there is no second server to forward upgrades to.

## 2. Mount the gateway in your server

`fallback` is a plain Node `(req, res)` handler, which is exactly what an Express app is:

```ts
import { createWorkerServer } from '@workerdeck/server'

const app = express()          // your API, your static SPA — unchanged
app.get('/api/docs', …)

const worker = createWorkerServer({
  fallback: (req, res) => { app(req, res) },
  profiles: [/* §5 */],
  authenticate: /* §3 */ undefined,
})
await worker.listen(8788, '127.0.0.1')
```

**Checkpoint:** `GET /v1/profiles` answers from the gateway, `GET /` answers from your app.

## 3. Authenticate with your app's own session

`authenticate` receives the raw request and returns a **principal** — any object you like — or
`null` to reject with 401. It is called for REST calls and for WebSocket upgrades, so this is the
one place your app's login meets the gateway.

```ts
authenticate: (req) => {
  const user = myCookieAuth.resolve(req)   // your existing session cookie
  if (!user) return null
  return {
    scope: { user: user.id },              // §4 — the whole ownership model
    allowedProfiles: ['wiki-agent'],       // this principal may use exactly this profile
  }
},
```

Three fields on the principal are read by the gateway; everything else is yours and comes back to
your hooks verbatim.

| Field | Governs |
|---|---|
| `scope` | which sessions this principal can see or touch (§4) |
| `allowedProfiles` | which profiles it may create sessions on |
| `operator` | access to gateway-wide surfaces (`/fs/*`, `/queue`, `/sdk-sessions`) |

Do expensive work here — a database lookup, a token exchange — and hang the result on the
principal. It runs once per request; the authorization predicate in §4 runs per *row*.

**Checkpoint:** a request without your cookie gets 401.

## 4. Ownership, without writing ownership code

`scope` is opaque string tags, assigned at create, immutable afterwards. The gateway stores and
enforces them; **you** decide what they mean. "user" is one app's vocabulary; the next app's is
"tenant" or "workspace".

The default rule is: every key the principal pins must match. So `scope: { user: 'alice' }` sees
alice's sessions and nothing else — enforced at the session routes, the list, the WebSocket attach
(*before* the wake, so nobody rebuilds a runner for a caller about to get a 404), deferred-execution
results, and the job routes.

Which means your client does **no ownership filtering at all**:

```ts
const { sessions } = await client.listSessions()   // already only this user's
```

That is the point. A check the client performs is a check the client can skip. If the default rule
is not yours, supply `authorizeSession(principal, session)` — but keep it synchronous, because it
runs for every row of every list.

Two things worth internalising:

- **A miss is 404, never 403.** Whether a session exists in someone else's scope is not this
  caller's business, and the answer is byte-identical to an unknown id.
- **Visibility is full control.** There is no read-only attach: a client that can see a session can
  message it, answer its approvals, interrupt it and close it. Scope is the boundary; `readOnly` on
  the panel is an affordance.

**Checkpoint:** user B gets 404 on user A's session id.

## 5. Give the agent a model

An embedded agent almost always wants the **provider engine** — any AI SDK model, no CLI
subprocess, no host filesystem — under a profile whose floor is nothing:

```ts
import { sandboxedProviderProfile } from '@workerdeck/server'

const profile = sandboxedProviderProfile(
  'wiki-agent',
  { id: 'openai', model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'], apiKeyEnv: 'OPENAI_API_KEY' },
  {
    instructions: SYSTEM_PROMPT,
    capabilities: ['web_fetch'],   // raised from nothing, deliberately, one at a time
    mcpServers: ['wiki'],          // §7
  },
)
```

`capabilities: []` and `mcpServers: []` mean *nothing*; leaving them **absent** means "whatever the
host wired". The empty arrays are load-bearing — do not normalise one into the other.

Then build the runner. `createProviderRunner` handles the four obligations that are invisible in
the types (forward `restore`, adopt `id`, seed the VFS only when *not* restoring, dispose on close):

```ts
import { createProviderRunner } from '@workerdeck/server'

createEngineRunner: (ctx) =>
  createProviderRunner(ctx, {
    model: (id) => openai(id ?? 'gpt-5.6-luna'),
    executor: quickjs,                       // §6
    capabilities: { webFetch: {} },          // backends; the profile decides the grants
    seedVfs: { '/README.md': 'scratch space' },
  }),
```

Note the split: the hook wires *backends*, the profile *grants* them. Wiring a backend only makes
it offerable.

**Checkpoint:** a session runs a turn and streams tokens.

## 6. Decide what it may reach

`sandboxedProviderProfile()` starts at: an in-memory scratch filesystem, and `eval_script` in a
QuickJS guest with no network. No shell, no host files, no egress. Raise it one grant at a time,
and know what each costs:

| Grant | Gives the agent | Costs you |
|---|---|---|
| `web_fetch` | read a public URL, digested by the session's model | egress, and page text entering the context as untrusted input |
| `web_search` / `download` | whatever backend you wire | the same, plus your search provider's bill |
| `deliver_file` | hand a scratch file to the user as a download | a surface your app must actually have |
| an MCP server | your data (§7) | exactly what that server exposes |

Where sandboxed code runs is a real decision, not a default — the trade is laid out in
[Engines and executors](/workerdeck/docs/reference/engines-and-executors/). The short version: run
it in-process when the data the loop reasons over is in your database; bridge it to the tab when
the data is *there* and you would rather not receive it.

**Checkpoint:** `eval_script` computes something; no host path is reachable by any tool.

## 7. Give it your data over MCP

You can hand the engine a plain `ToolSet` and the agent cannot tell the difference. Prefer a real
MCP server anyway: it is the seam you actually have (your tools are usually already an MCP server,
or want to be reachable by other clients), and it keeps identity off the model.

```ts
const { token, revoke } = mintSessionToken(ctx.config.scope.user)
const mcp = await connectMcpTools(
  { wiki: { type: 'http', url: MCP_URL, headers: { authorization: `Bearer ${token}` } } },
  { required: true },
)
return createProviderRunner(ctx, { …, mcp, onClose: async () => { revoke(); await mcp.close() } })
```

Four rules here, each of which cost the reference app real time:

1. **Identity rides the transport, never a tool argument.** A `userId` parameter is something the
   model can choose. A per-session bearer token minted in `createEngineRunner` is not.
2. **`required: true`.** Without it a failed connect produces a session that reports perfectly
   healthy and quietly has no tools — the agent apologises its way through every request that
   needed them, with one line in a log nobody is reading. Hand the *connection* over as `mcp`
   (not just `mcp.tools`) and a profile naming a server that didn't connect refuses to build.
3. **A stateless MCP server must answer `GET` with 405.** The client opens the SSE stream with a
   `GET` before it sends anything; under a framework's default 404 the whole connect fails with an
   error naming neither the method nor the route.
4. **Dispose in `onClose`** — which also runs when a session *parks*. A token that outlives its
   session is a credential nobody is tracking.

**Checkpoint:** `GET /v1/sessions/:id/mcp` lists your server as `connected`, with its tools.

### One action set, two callers

If your app's own API and your agent's tools are the same operations — and they usually are — write
them once. The reference app does exactly this with
[silkweave](https://www.silkweave.dev): an operation is a name, a Zod schema and a function, and
two adapters project the same set onto MCP (the agent) and tRPC (the SPA, typed end to end with no
codegen). At five operations that is tidy; at fifty it is the difference between one implementation
and two that drift — the app had `write_doc` and `PATCH /api/docs/:id` as one operation spelled
twice before this.

Three things make it work, and they generalise beyond any one toolkit:

- **Identity resolves per adapter and lands in the same place.** The agent arrives with a
  per-session bearer token; the browser arrives with your login cookie. Both must become the same
  thing by the time the function runs, so the function cannot tell — and must not care — which
  caller it is serving. In silkweave that is the context's `auth` key, set by the MCP mount and by
  `trpcNode`'s `authenticate` hook.
- **Mount, don't bind.** An adapter that starts its own server puts your API on another origin and
  breaks §1. You want the one that hands back a handler for the server you already have
  (`trpcNode()`, as of silkweave 5.1.0).
- **A shared set is not an identical one.** Keep the operations where the two callers genuinely
  differ on one side only — `whoami` and "navigate the user to this document" are agent tools; your
  SPA knows what it is showing.

One cost to budget for: a cookie-authenticated RPC endpoint is **CSRF-able**, and that guard is
yours. Check `Sec-Fetch-Site` (falling back to `Origin`) before you resolve the cookie, and
*decline* rather than throw so a forged request gets a plain 401 that explains nothing.

## 8. Put the panel in your UI

```tsx
<SessionPanel
  client={client}                       // ONE client per gateway
  key={sessionId}                       // remount by key; never by moving it in the tree
  sessionId={sessionId}
  transcriptVariant="lines"             // full-width rows, no cards — right for a narrow rail
  controlsSurface="status"              // model + mode into the panel's own status bar
  onVitals={(v) => setVitals(v)}        // live readings for your own chrome
/>
```

`baseUrl: '/v1'` — same origin, so the cookie rides both the REST calls and the socket, and there
is no key in the tab.

The panel owns the session's **one** attach. Anything else that wants live values reads them
through `onVitals` and changes them through `onControls`; opening a second attach means the
server's tool bridge may ask the wrong client. And do not let the panel's position in the tree
change: a remount drops the attach and the whole transcript.

## 9. App state and navigation: keep it yours

"Which document am I looking at" and "open that one for me" look like they want the tool bridge.
They don't, for two reasons:

- a bridged tool is by definition `sandboxed`, and
- the bridge asks the **first attached client** — with two tabs open, an arbitrary one answers.

Hold that state server-side, per user, and stream intents back down (SSE is plenty). Every tab then
agrees, and an agent working while the tab is shut still leaves the user in the right place. Report
honestly when nothing was listening — `shown: false` beats claiming a navigation that didn't happen.

This is app architecture, not a missing feature, and it is the one thing on this page WorkerDeck
should *not* solve for you.

## 10. What breaks in production

- **Restarts.** Provider sessions can `park()` — state persisted, runner torn down, rebuilt as
  itself. Configure `parking: { store: createFileSessionStore(…) }` or a restart loses every live
  session's transcript. The default in-memory store survives a disconnect, not a restart.
- **More than one pod.** Sessions are in-process. A second instance behind a load balancer does not
  see the first one's sessions, and the WebSocket must land on the pod that owns the runner. Pin by
  session id, or run one instance, until you have a story here.
- **Two tabs.** Both can attach; both can send. The bridge asks the first. Decide whether that is
  fine (it usually is) or whether your UI should say so.
- **Prompt injection through tool results.** A fetched page, a document another user shared, an MCP
  result — all of it is untrusted input that reaches the model as text. Grants are the mitigation:
  an agent that cannot delete cannot be talked into deleting. Say so in the system prompt too, but
  do not rely on it.
- **A destructive tool with no approval channel.** The provider engine's capability record says
  `interactiveApprovals: false` — there is nothing to gate a delete behind. The honest options are
  to grant it or not.

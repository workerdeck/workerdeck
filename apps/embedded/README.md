# Embedded sandboxed sessions — a reference implementation

A small wiki app whose right-hand sidebar is a **sandboxed agent**, with the WorkerDeck gateway
embedded in the app's own server. It exists to answer one question concretely: *what does it
actually take to put an agent loop in front of your own users?*

```
:8788 ─┬─ /v1/*   the WorkerDeck gateway (REST + the session WebSocket)
       └─ everything else, through the gateway's `fallback`:
          ├─ /trpc   the wiki, for the SPA    (cookie auth) ┐ ONE action set,
          ├─ /mcp    the wiki, for the agent  (session token) ┘ two adapters
          ├─ /api/*  login, app state, agent config
          └─ /*      the SPA
```

The wiki's operations are written **once**, in `src/wiki/actions.ts`, and projected onto both
transports. `update_doc` and "save this document" are the same function, not two implementations
that drift.

```bash
pnpm install
export OPENAI_API_KEY=sk-…        # or put it in the repo-root .env
pnpm --filter @workerdeck/embedded-example dev
# → http://127.0.0.1:8788, sign in as Ada, Grace or Alan
```

`pnpm dev` runs the server (`:8788`) and Vite (`:5193`) together. For the production shape — one
port, no Vite — `pnpm build && pnpm start`. If 8788 is taken (this repo runs several gateways),
the server says so and suggests the next port; `PORT=8790 pnpm dev` moves it.

| Variable | Default | |
|---|---|---|
| `OPENAI_API_KEY` | — | required |
| `EMBEDDED_MODEL` | `gpt-5.6-luna` | any model the key can reach |
| `PORT` / `HOST` | `8788` / `127.0.0.1` | |
| `EMBEDDED_DB` | `.embedded/wiki.db` | **data, not build output** — `pnpm clean` leaves it alone; `pnpm reset` is how you wipe it |
| `EMBEDDED_SECRET` | random per process | set it and logins survive a restart |

## What the agent can and cannot do

It runs the **provider engine** — no CLI subprocess, no host filesystem — under a profile built by
`sandboxedProviderProfile()`, whose floor is *nothing*. This app raises it in exactly two places
(`src/gateway.ts`), and the list is the whole grant:

| Granted | |
|---|---|
| `wiki__ListDocs/ReadDoc/CreateDoc/UpdateDoc/RenameDoc` | the signed-in user's documents, over MCP |
| `wiki__DeleteDoc` | permanent, id-only (see below), and there is no confirmation step to gate it behind |
| `wiki__Whoami` | who the user is and which document is on their screen |
| `wiki__OpenDoc` | navigate the user's app to a document |
| `fs_read` / `fs_write` / `fs_list` | an in-memory scratch VFS — a map, not a filesystem |
| `eval_script` | JavaScript in a QuickJS WASM guest: no network, no filesystem, interpreter-enforced time and memory limits |
| `web_fetch` | one public URL, behind the SSRF guard (loopback, RFC1918, CGNAT, 169.254/16 refused per redirect hop) |

Not granted, and not reachable: a shell, the host's files, an internal address, another user's
wiki, `deliver_file`, or any MCP server but this one. Asked to read `/etc/passwd`, the agent has no
tool that could — that is a capability record, not a system-prompt instruction.

## The seven things worth copying

**1. One origin, because of WebSockets.** The gateway serves the SPA and the API through its
`fallback` hook (`src/main.ts`). This is not tidiness: a browser cannot put an `Authorization`
header on a WebSocket upgrade, so a cookie is the only credential a tab can present on a session
attach — and a cookie only rides same-origin requests. Split them across two origins and the
sidebar cannot attach.

**…and one origin means every cookie-authed surface owes a CSRF check.** A cookie rides any
request the browser is induced to send, and `SameSite=Lax` stops only *cross-site* — a page on
another port of the same site sends it, and a `text/plain` body makes the request "simple" so CORS
is never consulted. The attacker never has to read the response: a forged `POST /v1/sessions` runs
a prompt of their choosing **as the victim**, with the victim's own wiki tools. So both
`authenticate` hooks — the gateway's in `src/gateway.ts` and the wiki API's in `src/wiki/trpc.ts` —
call `sameOrigin()` (`src/auth/cookie.ts`) before resolving the cookie, and *decline* rather than throw
so a forged request gets a plain 401 that explains nothing. Copying the cookie without copying this
is the mistake this app most invites.

**2. `scope` is the whole ownership model.** `authenticate` resolves the app's cookie and returns
`{ scope: { user: user.id } }`. That single line is why `GET /v1/sessions` returns only your
sessions, why another user's session id 404s on every route and on the WS attach, and why
`/v1/fs/*`, `/v1/queue` and `/v1/sdk-sessions` are closed to everyone here. **The SPA performs no
ownership check** — look at `AgentSidebar.tsx`: it calls `listSessions()` with no filter, because a
check the client performs is a check the client can skip.

**3. Identity reaches the tools through the transport, never through an argument.**
`createEngineRunner` reads `config.scope.user`, mints a per-session bearer token, and connects an
MCP client with it (`src/gateway.ts` → `src/wiki/mcp.ts`). No wiki tool takes a `userId` parameter,
because a parameter is something the model chooses. The token is revoked in `onClose` when the
runner is disposed, so it cannot outlive its session.

**4. Two independent checks on two different questions.** The gateway decides who may *drive a
session*; every SQL statement in `src/wiki/db.ts` carries its own `user_id`. Neither substitutes for the
other, and an agent that talked its way into the wrong tool arguments still comes up empty.

**5. UI state travels in both directions, and neither one is the tool bridge.** The agent runs on
the server; "which document am I looking at" is browser state and "open that one" is a browser
action. So the app owns its UI state *on the server* (`src/app/state.ts`): the tab `PUT`s it on
change, `wiki__Whoami` reads it, and `wiki__OpenDoc` records an intent that goes back down a
Server-Sent Events stream the tab subscribes to. WorkerDeck's own tool bridge would have looked
like the natural home for this and is the wrong one twice over: a bridged tool is by definition
`sandboxed`, and the bridge asks *the first attached client*, so with two tabs open an arbitrary
one answers. Keeping the state server-side means every tab of a user agrees, and an agent working
while the tab is shut still leaves the user on the right document. `open_doc` returns
`shown: false` when nothing was listening, so the model can say "I've queued that" rather than
claim a navigation that never happened.

**6. One action set, two callers.** `src/wiki/actions.ts` defines the wiki's six operations as
silkweave actions — a name, a Zod schema, a function. `src/wiki/mcp.ts` projects them onto MCP for
the agent; `src/wiki/trpc.ts` projects them onto tRPC for the SPA, typed end to end with no codegen
(`InferTrpcRouter` off the action list). Before this the app had two implementations of the same
six operations, already drifting: `update_doc` and `PATCH /api/docs/:id` were one operation spelled
twice. At six operations that is untidy; at fifty it is the product's whole maintenance cost.

What makes it work is that **identity resolves per adapter and lands in the same place**. The MCP
mount stamps `{ token, userId }` from a per-session bearer token; the tRPC mount resolves the app's
login cookie in `authenticate`. Both become `context.get('auth')`, so an action's `run()` cannot
tell — and must not care — which caller it is serving.

What is *not* shared is where the two callers genuinely differ: `whoami` and `open_doc` are on the
MCP adapter only. The SPA knows which document it is showing, because it is showing it. A shared
action set is not an identical one.

The cookie is also what makes `/trpc` **CSRF-able**, and that guard is the app's to write — see
`sameOrigin()` in `src/wiki/trpc.ts`, which checks `Sec-Fetch-Site` (falling back to `Origin`) and
declines rather than throws, so a forged request gets a plain 401 that explains nothing.

**7. The agent writes documents you may have open.** `DocEditor.tsx` keeps the loaded copy and your
draft apart, and when they diverge it offers the choice instead of picking — the same split
`useOpenFiles` makes in `@workerdeck/react`. Silently discarding either side is the one behaviour
that would make the agent feel unsafe to use.

## Layout

The folders are the architecture: **one `wiki/` action set with its two transports beside it**,
the app's own surface in `app/`, and identity in `auth/`. `gateway.ts` stays at the top because it
is the file you came here to read.

```
src/
  main.ts        composition — one port, the `fallback` wiring
  gateway.ts     createWorkerServer, the profile, createEngineRunner
  shared.ts      the types the SPA also imports — the src ↔ web contract
  wiki/
    actions.ts   the wiki's operations, written once — READ THIS FIRST
    mcp.ts       those actions as MCP, for the agent  (per-session token)
    trpc.ts      those actions as tRPC, for the SPA   (cookie + CSRF guard)
    db.ts        node:sqlite, one file, no dependency
  app/
    routes.ts    login, app state, agent config, static SPA
    state.ts     what the user is looking at, and the channel that moves them
  auth/
    users.ts     three users in the source — delete this to swap in real auth
    cookie.ts    the signed cookie and `sameOrigin`, the guard that makes it safe
web/
  lib/
    trpc.ts      the typed client — `WikiRouter` comes straight off the actions
    api.ts       the plain-fetch half (login, app state, the SSE stream)
  components/    the SPA — `AgentSidebar.tsx` is the part to read
```

`auth/` splits on purpose: `users.ts` is the demo and is meant to be deleted, `cookie.ts` is the
part worth keeping whatever ends up resolving the identity.

## Known edges

- **Sessions do not survive a server restart.** The provider engine reports `resume: false`, so
  dormancy skips it, and `park()` only applies to a loop resting on deferred calls. Restart the
  server and the sidebar starts empty. On Kubernetes that means conversation lifetime = pod
  lifetime; see `docs/GOTCHAS.md` §Session scope.
- **Visibility is full control.** A principal who can see a session can drive it — send messages,
  interrupt, close. There is no read-only sharing level yet.
- **The MCP endpoint is stateless and answers `405` to `GET`.** Silkweave's transport serves one
  request/response per call with no standing SSE stream, and MCP requires 405 (not 404) from a
  server that offers none — without it the client reads "wrong endpoint" and the whole connect
  fails. Silkweave 5.1.0 ships the responder (`transport.methodNotAllowed`) rather than leaving
  every host to rediscover the rule.
- **No tool infers its operation from an absent field**, and this one was paid for in blood. There
  was a single `write_doc` that created when `id` was missing and overwrote when it was present. A
  live model sent `id: " "` — one space — on twenty consecutive attempts to create a document, so
  every one of them tried to overwrite a document named `" "` and failed with "no such document".
  `z.string().min(1).optional()` looks like the fix and is not: a space has length 1. Worse, a
  provider may rewrite the schema so every property is required, leaving the model no way to omit
  anything at all. So there are now two tools, `create_doc` and `update_doc`, each with required
  arguments — the intent lives in the name, where it cannot be lost — and `text()` in
  `wiki/actions.ts` trims-and-blank-checks every optional string as a second layer.
- **A destructive tool here cannot ask.** The provider engine's capability record says
  `interactiveApprovals: false`, so `DeleteDoc` has no approval channel to sit behind — the honest
  choice is to grant it or not. What this app does instead is narrow the blast radius: it takes an
  **id only** (every other tool accepts a title fallback, and that lookup is case-insensitive and
  picks the first of any duplicates — fine for reading, a way to destroy the wrong document for
  deleting), so the model must resolve the title with `ListDocs` first, which also puts the id in
  the transcript where the user can see it. An app with more to lose should weigh granting it at
  all, or run this engine behind one that can prompt.
- **Tool results are untrusted input.** A sandbox bounds what a tool can reach, not what a fetched
  page can talk the model into asking for. The system prompt says so; a production app should
  think harder about it than a demo does.
- **`web_fetch` is not pinned against DNS rebinding, and that is a loopback-demo trade.** Core's
  `web_fetch` resolves the hostname and refuses private, loopback and link-local addresses, but
  Node's `fetch` then resolves it *again* — so an attacker-controlled domain that answers a public
  address to the guard and `169.254.169.254` to the fetch gets through. On this demo the only thing
  behind that is the app's own loopback `/mcp`, which 401s without a bearer token. **In a cloud
  deployment it is the metadata service**, reachable by a prompt-injected loop. Pass a `fetchImpl`
  backed by a resolve-and-pin agent (or an allowlist) to the capability before running a copy of
  this app anywhere with an IMDS endpoint; core leaves the hook open precisely for that.

# Gotchas & invariants

Things that cost someone a debugging session. Each one is load-bearing: the obvious-looking
change is the wrong one. Grouped by where they bite. Architecture lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); this is the list of ways to get it wrong.

## Claude engine (Agent SDK / CLI)

- `cwd` is per-query in the SDK; the runner re-pins it every call. `SessionInfo.id` (server id) ≠
  `sdkSessionId` (SDK session id used for `resume`).
- The SDK version floats (`^0.3.x`) and its unions grow; protocol mirrors must stay assignable
  BOTH ways (SDK→protocol for events, protocol→SDK for options). Unmodeled SDK messages pass
  through as `sdk_event` — extend the protocol first-class, don't parse payloads client-side.
- `total_cost_usd`/`num_turns` on result messages are session-cumulative — roll up last-seen,
  never sum. `usage` is per-turn — token accounting sums input+output+cache_creation+cache_read.
- On `resume` the SDK re-streams only user messages; the runner backfills full history as
  `replay: true` events and the reducer dedupes doubled user messages by uuid. The SDK never
  echoes streamed-input user messages — the runner emits `user_message` itself in `sendMessage()`.
- Promptless sessions emit no `system_init` until the first message, but the CLI answers control
  requests immediately — the runner fetches capabilities/context eagerly; `useClaudeSession`
  seeds mode/model/status from the `attached` frame's SessionInfo.
- CLI telemetry quirks (smoke-verified, SDK 0.3.221): `getContextUsage().categories[].color`
  holds CLI theme token names, not CSS; rate_limit events can omit `utilization` — render
  unknown, never 0%.
- **The model list needs shaping, and it happens once, in `core/src/normalize.ts`**
  (`modelOptionsFromSdk`) so no client invents its own. Three traps, all live:
  `supportedModels()` leads with a `value: 'default'` sentinel that is a *choice*, not a model —
  a session running on it reports something else, so a picker row for it can never be checked and
  a status bar naming it says "Default" for a session answering as Opus. It is dropped, and its
  `resolvedModel` is forwarded as `capabilities.defaultModel` instead, which is the only way to
  name a promptless session's model before its first turn. `displayName` is the family alone
  ("Opus") or carries a variant instead of a version ("Opus (1M context)"), so rows are renamed
  from their resolved id. And the list is flat: `primary` (newest of each family) is derived here,
  because the CLI reports no grouping and every UI would otherwise guess differently.
- The model list is **only ever current models** — the older versions Claude Code's own picker
  files under "more models" are in neither `supportedModels()` nor `initializationResult()`
  (checked directly against the SDK). Which model names you get is a function of the pinned SDK
  version, nothing else: 0.3.217 reported Opus 4.8, 0.3.221 reports Opus 5.
- The CLI **pushes** a `rate_limit_event` only when a window *changes*, so a session that is
  watched rather than driven would show no plan usage at all. The runner therefore polls the
  structured `/usage` control request after init and after every turn and re-emits the windows as
  ordinary `rate_limit` events (`rateLimitEventsFromUsage` in `core/src/normalize.ts`) — clients
  need nothing new, and replay covers late attachers. That control request is marked experimental
  in the SDK, method name included, so it is probed for by name and every failure is silent: if
  it disappears, usage goes back to change-only, and nothing else breaks.

## Permissions

- Allowing a permission MUST echo the tool input as `updatedInput` (undefined → ZodError → tool
  errors). The fake harness can't catch this class of bug — permission changes need a smoke.
- Switching a live session into `bypassPermissions` needs `allowDangerouslySkipPermissions` at
  spawn (smoke-verified CLI refusal otherwise), which is fixed for the session's lifetime and so
  is reported as `SessionInfo.canBypassPermissions` — a picker disables the mode instead of
  offering a switch the engine will refuse; `auto` mode is gated CLI-side (model/plan
  support, settings opt-out). Rejected `set_permission_mode` = `protocol_error` frame —
  `useClaudeSession` exposes it via `onProtocolError`; SessionPanel toasts it.
- `AskUserQuestion` rides canUseTool; answers = allow with `updatedInput.answers` (question →
  label(s), comma-joined). `questionBehavior` policy-resolves it unattended ('auto' first option,
  'deny' model decides); under 'ask', job webhooks carry the request for remote answering.
- `PermissionMode`'s vocabulary is Claude Code's; `AiSdkRunner` supports only
  `default`/`bypassPermissions`/`dontAsk` and throws otherwise (surfacing as `protocol_error`).
  `supportsPermissionMode(engine, mode)` in protocol is the ONE source of truth for that
  restriction — create forms filter what they offer with it, the gateway 400s a session/job
  create with it, startup refuses a provider profile whose `defaults.permissionMode` fails it.
  Don't re-encode the list anywhere (the example used to coerce; it no longer does).

## Provider engine (AI SDK v7)

- v7 inverts two conventions this repo had baked in: `result.usage` is **already cumulative**
  across steps (summing per-step usage on top double-counts — `AiSdkRunner` maps it once per
  turn), and a tool without a local `execute` **terminates** the loop rather than pausing it.
  Continuation is therefore message-state replay (persist `responseMessages`, append a
  `ToolResultPart`, re-invoke), not resuming a suspended loop. Approvals map to v7's separate
  `toolApproval` mechanism, not to execute-less tools. v7 is ESM-only and needs Node ≥ 22.
- `AiSdkRunner` STREAMS every leg (`agent.stream`, never `generate`): `stream_delta` per token
  (suppressed by `includePartialMessages: false`) and assistant/tool messages flushed per step —
  so tests must mock `doStream` (model-level parts incl. a `finish` with usage), not
  `doGenerate`; only `generateDigest` still consumes `doGenerate`.
- A third v7 trap (hit live: a deepwiki MCP transport failure hung a session): a thrown `execute`
  yields a `tool-error` part that is **absent from `result.toolResults`** even though the SDK
  already fed the error back and kept looping. Deriving "which calls parked" from `toolResults`
  parks forever on an already-answered call — `AiSdkRunner` derives settled ids from
  `responseMessages` tool parts instead. Related invariants: tool results are spliced BEFORE user
  messages typed mid-park (providers reject non-adjacent results), `interrupt()` rescues a parked
  turn by failing its calls, and a turn whose history already ends with the assistant is skipped
  (double-scheduled turns must not double-generate).
- Provider engines have no `supportedModels()`: the model picker offers `provider.models` as the
  operator declared it on the profile, falling back to `provider.model` alone. Don't ship a
  static per-provider model table — it goes stale and lies outright for openai-compatible
  endpoints. `SessionInfo.engine` is reported by each runner itself (not looked up from the
  profile) so any session surface can gate CLI-only affordances; no event carries it, the attach
  snapshot is the only source.
- `createEngineRunner` may return a promise, so per-session assembly (an MCP connect, a
  credential lookup) can be awaited there, disposed via `AiSdkRunnerConfig.onClose`; a rejection
  fails the create (session POST 500s with the message, a job goes straight to `failed`). The
  example and the SDK smoke still share ONE process-wide MCP client (sessions must not close it)
  — right for one public endpoint, not a constraint any more.

## Tool trust & the sandbox

- Tool trust is load-bearing, not decorative: only `sandboxed` tools may leave the server, and
  they're the ones declared WITHOUT `execute` (the AI SDK halting on those IS the seam). MCP and
  any secret-bearing tool is `authoritative` — bridging one would let a browser forge
  authoritative results. `withMcpTools` throws on a name collision for that reason.
- Sandbox guest limits are interpreter-enforced, but the interrupt deadline **cannot preempt time
  inside a host function** — give every granted capability its own timeout (see
  `QuickJsExecutor#fetchText`). Host↔guest values cross **by value only**; never hand the guest a
  host object by reference (that prototype-chain leak is the CVE-2026-5752 failure shape, covered
  by a red-team test).
- AI SDK MCP lives in `@ai-sdk/mcp` (not `ai`) as of v7, is imported lazily, and supports
  **http/sse only** — stdio is local-only upstream and is rejected explicitly. Claude-engine
  sessions still do stdio, since the CLI spawns those itself.
- `web_fetch` is layered: `createWebFetch` (core) does the SSRF-guarded fetch (DNS-resolved,
  private/link-local denied per redirect hop; cross-host redirects surface a notice instead of
  following; 15-min page cache by URL) and the digest pass runs on the **session's own model**
  via `AiSdkRunner.generateDigest`, which adds its tokens into `#turnAccum` — any extra model
  call made outside that method loses tokens from the turn's accounting. The digest is never
  cached (it's per-prompt).
- `deliver_file` exists only when `onFileDelivered` is wired; `createEngineSession` grants it by
  default (`capabilities.deliverFiles: false` withholds it). Delivered files are downloadable
  only while the session lives — in-memory VFS; durability is the persistence tier.

## Parking & bridged execution

- Parking is a persistence boundary, not an ending, and its invariants are load-bearing:
  `park()` emits `status_changed: 'parked'` and NEVER `session_closed`, snapshots *after* that
  emit and keeps the seq counter (a rehydrated runner continuing at a reused seq is silently
  dropped by the reducer's and client's `seq <= lastSeq` dedupe), and refuses while a leg is in
  flight or any pending call is non-deferred. The runner announces the park only once **every**
  call of the batch has been dispatched — parking on the first `execution_dispatched` would
  snapshot a session whose remaining calls then dispatch into a discarded runner.
- The engine's `state` inside a snapshot is opaque on purpose: typing it would drag `ai`'s
  `ModelMessage` into `packages/server`, which must not resolve a model SDK at all.
  `registry.evict()` (not `remove()`) drops a parked runner — `remove()` closes it. A rebuild
  that ignores `EngineRunnerContext.restore` produces a fresh id and is refused with a loud
  error, because the silent version is a session that quietly forgot its task.
- A durable `SessionStore` persists the record's config, and `toDurableRecord` (what
  `createFileSessionStore` applies) drops four fields from it: `queryFn`, `historyFn`,
  `extraOptions`, `env`. Two are functions JSON would eat silently, and `env` is credentials —
  no store may ever hold those. Nothing is lost, because all four belong to the Claude engine and
  the Claude engine cannot park; a rebuilt provider session resolves credentials through
  `createEngineRunner` from the live environment on every build. A host that smuggles live values
  into `config` for its factory to read back is the one thing this breaks — resolve them in the
  factory instead.
- Store operations are serialized per session (`SessionParkManager#queue`), and that ordering is
  load-bearing the moment writes are real I/O. `#park` MUST evict before the save completes (an
  attach in between binds a client to an inert runner), so there is a window where the session is
  in neither the registry nor the store — a delivery reading past it 404s the caller, files the
  execution as settled, and leaves a record nothing alive can wake; a `discard` reading past it
  deletes nothing and lets the save resurrect a closed session. Read paths (`get`, `listInfo`)
  queue behind the write for the same reason.
- Re-arming a watchdog at `hydrate()` uses `max(expiresAt, now + expiredGraceMs)` (default 60s):
  a deadline that lapsed during a restart must not fire at t=0, or the boot fails every parked
  execution before the delivery that was retrying against a down server can land. Storage-side,
  a file store is single-process (two servers over one directory both hydrate and both rebuild),
  its `list()` reads every transcript into memory, and its directory is plaintext transcripts
  (written 0600 under a 0700 dir). Two things a restart does NOT carry over: `#settled` is
  in-memory, so a duplicate delivery after a restart is a 404 rather than `applied: false`, and a
  parked *job*'s queue-side record belongs to the `QueueAdapter` — a durable `SessionStore` under
  the bundled in-memory adapter wakes a session no job is waiting on.
- Bridged tool calls: the server asks the **first attached** client and fails dispatch fast when
  none is attached (which is why autonomous jobs simply never bridge). Results are idempotent by
  `executionId` — a late answer racing a timeout is expected and must not error the client or
  re-open a settled call. The server feeds every bridged result into the session runner's
  optional `settleExecution` before the host's `bridge.onResult` observer — operators don't wire
  that loop themselves. A runner whose id isn't known yet at assembly time reaches its bridge
  executor via a dispatch-time delegate on `call.sessionId` (see `smoke/sdk-client.ts`). The
  browser guest engine is loaded on first bridged call, never at import; keep it that way (it is
  ~2 MB) and keep the variant an optional peer dep.

## Server, profiles & auth

- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
- **A browser cannot authenticate a WebSocket attach with a header** — the `WebSocket` constructor
  takes `(url, subprotocols)` and nothing else, and the one `authenticate` hook guards REST *and*
  the upgrade. So a dashboard has exactly three options: a cookie (sent automatically on a
  same-origin upgrade), a query-string ticket (`ClientOptions.buildWsUrl` exists for this, but
  something has to issue the ticket), or a server-side proxy that stamps the credential on the
  tab's behalf. Baking a key into the served JS is not one of them. `packages/cli` takes the cookie
  route, which is the entire reason it serves the app and `/v1` from one origin via the `fallback`
  option. Anything reached through `fallback` is outside `basePath` and gets no `authenticate`
  call — that namespace is the host's to guard.
- Cookie auth means ambient authority, so CSRF is live: WebSocket upgrades are **exempt from
  CORS**, which makes an explicit `Origin` check — not `SameSite` alone — the actual defense on an
  attach.
- The CLI's generated auth key is two halves of one promise. `resolveInstanceConfig` is pure (no
  I/O), so when auth is required off loopback with no key it only *records* `generateAuthKey` —
  and already stands the Host-header guard down (`allowedHosts: null`) on the strength of it.
  `startInstance` materializes the key (`<stateDir>/auth-key`, 0600, regenerated if corrupt,
  ephemeral when `stateDir` is null) and then refuses to serve if `allowedHosts === null` while
  the built-in auth came up disabled. Keep that assert: it is what turns "auth believed on,
  secret undefined" — a silently open gateway wearing an authenticated banner — into a failed
  start. Relatedly, `insecureHosts` entries match the **bind host** literally (`0.0.0.0` waives
  auth only for the all-interfaces bind, never "any host") and fold into `allowedHosts`, which
  still fences an unauthenticated instance to loopback + declared names against DNS rebinding.
- Profiles pin `CLAUDE_CONFIG_DIR` *after* the `buildRunnerConfig` hook (profile wins over
  hook-set env); profile `defaults` fill unset request fields only. An `ANTHROPIC_API_KEY` in the
  server env still outranks every profile's config-dir credentials (SDK chain) — surface, don't
  fight it. The oauth notice is per-profile.
- **Setting `CLAUDE_CONFIG_DIR` at all changes the CLI's credential source**, not just its config
  dir: set, credentials come from `<dir>/.credentials.json`; unset, the CLI's own resolution runs
  — which on macOS is the login Keychain, where `claude login` puts a claude.ai login. So pinning
  even the CLI's default `~/.claude` turns a working Mac login into "Not logged in · Please run
  /login" (reproduced: same prompt, same cwd, only the env var differs; `apiKeySource` is 'none'
  both ways, so it can't discriminate). `claudeSessionEnv` in server.ts therefore *skips* the pin
  when the baseline env already lands the CLI in the profile's dir — that skip is load-bearing
  (it's what makes the auto-detected `default` profile work on a Mac), and so is its converse:
  a baseline carrying a *different* `CLAUDE_CONFIG_DIR` is still overridden by the profile, or
  two profiles collapse into one identity. A profile whose dir is NOT the default needs its own
  credentials: run `CLAUDE_CONFIG_DIR=<dir> claude auth login` (writes `<dir>/.credentials.json`),
  or inject a long-lived `CLAUDE_CODE_OAUTH_TOKEN` via `buildRunnerConfig` (the launchd pattern
  in `examples/workerdeck.config.mjs`). The `checkCredentials` preflight probes each profile's
  exact session env with `claude auth status` at `listen()` and warns on a logged-out verdict —
  warn-only, silent on "couldn't check", off by default in the library, on in the CLI, and it
  reads nothing but the `loggedIn` boolean (never credential material or account identity).
- Profile management is doubly opt-in (a `profileStore` AND `canManageProfiles`) and the two
  profile sets never mix: `profiles` from server options are code — immutable over HTTP, and they
  win a name collision — while the store holds UI-created ones. `validateProfile` is shared by
  startup and the routes so a POSTed profile can never be one startup would have refused, and
  `managed` is recomputed on every response (never persisted, never trusted from a client). A
  managed *Claude* profile needs `allowedConfigDirRoots`: naming a config dir is choosing a
  credential store, so unset means the routes create provider profiles only. Profiles can't be
  renamed — sessions and jobs are pinned to the name. A store does NOT suppress the auto-detected
  `default` profile; opting out of that is still `profiles: []`.
- Provider-session grants live on `ProfileInfo.session` (`capabilities`, `mcpServers`,
  `instructions`) and narrow — never widen — via `CreateSessionRequest.capabilities`; the gateway
  400s a widening request rather than silently downgrading it. MCP is **named, never configured**
  there: a transport config's headers can carry credentials and `ProfileInfo` is served by
  `GET /profiles`, so the names refer to servers the host connected in `createEngineRunner` and
  `selectMcpTools` filters by the `<server>__<tool>` namespace. For the same reason a provider
  session request carrying its own `mcpServers` is refused (MCP tools are authoritative — a
  client that could name one could point an authoritative tool anywhere); Claude sessions still
  bring their own, since the CLI spawns them under the operator's own config dir.
- **Session notifications subscribe through `SessionRegistry.onRegister`, and three details of
  that seam are load-bearing.** (1) `register()` fires the hook per *runner object*, not per call
   — `prepare()` lists a runner and its caller registers what it returned, so a per-call hook
  fires twice for every Claude session and every notification is delivered twice. (2) The
  subscription starts at `runner.info().lastSeq`, because `Runner.subscribe(fn, afterSeq = 0)`
  **replays the log**: at 0, a session rebuilt from a park re-announces every permission request
  it ever made. (3) The `SessionInfo` snapshot is taken a microtask after the event, since
  listeners run *inside* `#emit`, before the runner has applied what the event means — read
  synchronously, a `session_closed` notification reports `status: 'starting'`. Seq and ts still
  come from the event, so identity and ordering are untouched.

## Host filesystem (`/v1/fs/*`)

- **`cwdAllowed` is not the containment check for these routes, and reusing it would be a hole.**
  It resolves `..` and compares prefixes, which is sound for its own job — vetting a cwd the
  *operator* typed. The `/fs` routes walk paths the *agent* may have authored, so a symlink
  planted inside an allowed root (`root/notes → ~/.ssh`) defeats any lexical check. `host-files.ts`
  decides containment only on `realpath` output, and canonicalizes the roots themselves at
  startup — a root that is itself a symlink (`/tmp` → `/private/tmp` on macOS) otherwise contains
  nothing. Requests go to `realpath` **whole**, never lexically collapsed first: `root/link/..` is
  lexically `root` and physically the link target's parent, and only the physical answer is true.
- **Every filesystem refusal is an identical `404 'not found'`** — outside the roots, escaped via
  symlink, dangling link, and genuinely absent are byte-identical. Anything finer turns the API
  into an existence oracle for paths outside the roots (a planted link answering 403 iff
  `~/.ssh/id_rsa` exists). `403` is reserved for verdicts that leak nothing beyond the roots:
  malformed requests, and in-root targets of the wrong kind. Don't "improve" these messages.
- **Resolve and open are two halves of one discipline.** Resolution's guarantees hold at resolve
  time only, so callers open exactly `ResolveOutcome.path` through `readContained`/`writeContained`:
  `O_NOFOLLOW` turns a final-component swap into `ELOOP`, `O_NONBLOCK` makes a swapped-in fifo open
  instantly rather than parking the request forever, the `fstat` gate refuses non-regular files
  before a byte moves (`/dev/zero` would otherwise be an unbounded read), and truncation happens
  only after that gate. A *parent* directory swapped inside the window can still redirect the
  open — that needs `openat2(RESOLVE_BENEATH)`, which Node does not expose; accepted, documented.
- **Reading follows `allowedCwdRoots`; writing does not.** `hostFiles.roots` is a *narrowing*, not
  the enabling grant — a caller holding the auth key can already start a session in any allowed
  root and have the agent read what's in it, so serving those trees over `/fs` adds no authority
  it didn't have. Writing keeps its own switch precisely because it *isn't* implied: an agent's
  writes go through the permission flow and a `PUT /fs/write` does not. Two boundary cases are
  load-bearing: with neither `hostFiles.roots` nor `allowedCwdRoots` the routes 404 (the
  permissive "unset means anywhere" cwd default is about paths the operator types, never a licence
  to serve `/`), and an explicit `roots: []` disables them rather than falling through to the cwd
  roots — hence `??` and not `||` at the resolution site.
- **Writes are conditional, always.** `expectedHash` (sha256 of what was read) or nothing, and
  nothing means "create" — a path that already exists then 409s. There is no unconditional
  overwrite, because the agent is editing the same tree; a client that lost track of its base can
  only re-read, never force. The response's own hash chains into the next write.
- **`/fs/find` walks, so it must not follow.** The recursive search (`host-file-search.ts`) skips
  symlinks as files *and* as directories: as directories that is the difference between a bounded
  walk and a cycle, and as files it guarantees every path it offers is one `/fs/read` will accept.
  It never resolves a path of its own — it is handed an already-contained directory — which is why
  it lives beside the containment core rather than inside it.
- These routes are **operator-privileged**: authorized by the auth key alone, deliberately outside
  the agent permission flow. That is not the trust story of a tool call — which is exactly why the
  bypass that matters (writing) is its own flag.

## APNs push (the CLI's forwarder)

- **Sandbox and production are different token *namespaces*, not just different URLs.** A build
  run from Xcode gets a sandbox token; a TestFlight or App Store build gets a production one.
  Same key, same phone, different token — push one at the wrong endpoint and Apple answers
  `BadDeviceToken` forever. So the environment is a property of *each registered device*, never a
  server-wide flag: the app reads `aps-environment` out of its embedded provisioning profile,
  sends it with the token, and the forwarder routes each token to its own host. A `#if DEBUG`
  guess is wrong for a Release build run from Xcode, which is exactly when you'd be debugging.
- **The provider JWT must carry a raw `r||s` signature, not DER.** `crypto.sign('sha256', …)`
  produces a DER SEQUENCE unless given `dsaEncoding: 'ieee-p1363'`, and Apple's answer to the
  difference is a bare 403 with nothing to debug from.
- **Do not re-sign the provider token per push.** Apple rejects one older than an hour *and*
  rate-limits refreshing it (`TooManyProviderTokenUpdates`); the client caches for 40 minutes,
  which sits in the middle of that window.
- **Apple throttles a provider that repeatedly pushes to invalid device tokens** — connections
  start dying with GOAWAY and cancelled streams that look like a network fault. One probe with a
  bogus token is a legitimate credential check (a good JWT gets `BadDeviceToken`, a bad one gets
  `InvalidProviderToken`); a loop of them is self-inflicted. Relatedly, a stream that never left
  the queue reports only "the pending stream has been canceled", so the client keeps the
  *session's* error and reports that instead — otherwise DNS failure, TLS failure and Apple
  hanging up are indistinguishable.
- `fetch`/undici will not do: APNs is HTTP/2 only, hence `node:http2` directly.
- The APNs key's **environment and restriction scope cannot be changed after the key is created**
  (the portal now forces the choice at creation, and a team gets only two active keys). WorkerDeck's
  is "Sandbox & Production" + "Team Scoped", which is what lets one key serve both endpoints.

## Build, test & packaging

- A package that imports a workspace sibling needs the vitest workspace-source alias (see
  `packages/core/vitest.config.ts`) — the `@workerdeck/source` condition alone isn't enough,
  vite-node externalizes siblings to their unbuilt `build/` entries.
- Inter-package deps are `workspace:*`, and **pnpm must be what packs them**: `pnpm publish`/`pnpm
  pack` rewrite the protocol to the concrete version, `npm publish` does not — npm can't resolve
  it, since this workspace is declared to pnpm alone (no `workspaces` field in the root
  package.json), so it would ship `workspace:*` verbatim and break every consumer.
- **A brand-new package cannot have its first release published by `publish.yml`.** Trusted
  publishing is configured *per package* on npmjs.com, and that settings page only exists once the
  package does — so the first version of a new name has to go out by hand, authenticated normally
  (`pnpm publish --access public` from `packages/<new>`, with 2FA), *then* the trusted publisher is
  configured, and every later release goes through CI. Skip this and the tagged run fails at the
  publish step having already passed the whole gate. The rest of the packages in the same run are
  unaffected — `pnpm publish -r` skips versions already on the registry, so a re-run is safe.
  Observed at 0.5.0: the OIDC exchange 404s (`[WARN] Skipped OIDC:
  ERR_PNPM_AUTH_TOKEN_EXCHANGE`) and the publish then 404s on `PUT` — because npm has no trusted
  publisher to authorise *creating* the name. `pnpm publish -r` walks in dependency order and
  stops at the first failure, so packages after it never publish; check the registry rather than
  assuming the whole run failed.
- **A publish is visible to the write path before the read path.** Straight after publishing a new
  name, `npm view <pkg>` and `npm install` can 404 for minutes while the *packument* is indexed,
  even though `GET /<pkg>/<version>` already returns 200 and `npm access get status` reports it
  public. A re-publish attempt answering `E403 "cannot publish over the previously published
  versions"` is proof the first one worked — do not mistake the 404 for a failed publish and
  re-run. `npm cache clean --force` clears the negative cache locally.
- **Configuring a trusted publisher needs npm ≥ 12**, and the CLI will not tell you why. The call
  is `npm trust github <pkg> --file publish.yml --repo <owner>/<repo> --allow-publish`; the
  registry rejects any config with no `permissions` field, and npm 11 has no concept of one (it
  sends `{type, claims}` only), so every call 400s no matter what you pass. npm 12's
  `--allow-publish` / `--allow-stage-publish` are what become `permissions: ["createPackage"]` /
  `["createStagedPackage"]`, and at least one is mandatory. What makes this expensive to diagnose
  is that npm **drops the registry's explanation**: npm-registry-fetch's `HttpErrorGeneral`
  appends only `body.error`, while the trust endpoint answers with `body.message` — so you get a
  bare `400 Bad Request` and no reason (npm/cli#9377). Anything built on this CLI inherits that
  blindness; read the response body yourself. Two more traps in the same command: `--repo` must
  match the real remote **case-sensitively** or OIDC rejects the token later at publish time, and
  `--file` takes the workflow *filename*, never its path.
- *Running* a trusted publish is a different version floor: npm ≥ 11.5.1 / Node ≥ 22.14, and
  pnpm's own OIDC support needs pnpm ≥ 11.1.0 — `actions/setup-node` writes an unresolved
  `${NODE_AUTH_TOKEN}` into `.npmrc`, and 11.0.8 sent that placeholder as auth (404s). A trusted
  publisher is bound to the workflow *filename*, and a tag runs the workflow from the TAGGED
  commit — so a tag that predates `publish.yml` publishes nothing.
- **A throttled registry read is indistinguishable from a 404.** Under rapid repeated calls
  `npm view <pkg>` answers as though the package does not exist. Any script that branches on
  "is this published yet?" has to retry before believing the negative, or it silently skips
  packages that are in fact on the registry.
- streamdown (ui's markdown renderer) needs its whole `dist` dir `@source`-scanned; under pnpm it
  lives at `packages/ui/node_modules/streamdown`, not the workspace root.
- **Everything publishable lives under `packages/`, and that is load-bearing.** Three release
  invariants disagree about paths: `publish.yml`'s tag/version gate reads only
  `readdirSync("packages")`, `version:set` filters `./packages/*` — but `pnpm publish -r` walks
  *every* non-private workspace package, `apps/` included. A publishable package under `apps/`
  would therefore ship while being invisible to both the version bump and the tag check: a stale
  version, silently, on every release. This is why the dashboard is `packages/web` and not
  `apps/web` — it is published, so all three have to agree about it.
- The root package is `workerdeck-monorepo`, not `workerdeck`. The unscoped npm name belongs
  to `packages/cli`, and two packages with one name in a pnpm workspace is a conflict. The root is
  private, so its name is cosmetic — but don't "fix" it back.
- `packages/web` is published as **static files with zero runtime dependencies** — everything it
  builds with (React, the router, Tailwind, the workspace packages) is a devDependency, because it
  all ends up compiled into `dist/`. Declaring any of them a dependency would make consumers
  install a toolchain to obtain files. Its entry (`entry.mjs`) is hand-written and outside vite's
  graph, so the published entry can never drift from the published `dist/`.
- `packages/cli` gets the dashboard from a **runtime dependency** on `@workerdeck/web`, not a
  vendored copy: `resolveWebRoot()` is that package's exported `dashboardDir`. Two consequences.
  In a checkout it resolves to `packages/web/dist`, which only exists once the app has been built
  — dev never builds, so `pnpm --filter @workerdeck/web run build` is a prerequisite for
  running the CLI from source (`resolveWebRoot()` throws with that instruction). And in
  `packages/cli/vitest.config.ts` the workspace-source alias needs an explicit entry for `web`
  *before* the general rule: `web` is an app with no `src/index.ts` for the regex to find.
- The dist is portable only because the SPA builds its client from `location.origin` and uses hash
  history; `packages/web/vite.config.ts` sets no `base`, so assets resolve from an absolute
  `/assets/...` and the dashboard **must be mounted at a domain root**. Subpath mounting would be
  a build-time `base` decision, not a runtime flag.
- `packages/web`'s build drops the legacy `.woff` files that `@fontsource` emits alongside
  `.woff2` (`scripts/trim-fonts.mjs`, ~660 KB). The generated `@font-face` lists `woff2` first, so
  any browser that can run the app never requests them. It happens in the *producing* package so
  every consumer gets one payload.
- The CLI loads `workerdeck.config.mjs` through a dynamic `import()` of a *runtime* path on
  purpose: it is the operator's code, not part of our module graph. Keep the specifier
  non-literal so no bundler tries to resolve it — and note vitest cannot load a config fixture from
  outside the project root, which is why `packages/cli/test` writes them under the package.

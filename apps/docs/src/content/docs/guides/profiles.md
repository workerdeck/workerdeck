---
title: Profiles
description: What a session runs as — a named Claude Code config directory, or a model provider for the model-agnostic engine.
order: 5
---

A **profile** is what a session runs as. Most commonly it binds a name to a Claude Code config
directory: the spawned CLI process gets that directory as `CLAUDE_CONFIG_DIR`, so it loads the
directory's settings, memory, skills — and resolves whatever credentials it holds. The canonical
use case is a shared machine where several team members each keep their own config dir:

```ts
createWorkerServer({
  authenticate: async (req) => {
    const user = await verifyMyAppToken(req.headers.authorization)
    return user && { allowedProfiles: user.profiles } // e.g. ['ada']
  },
  profiles: [
    { name: 'ada', configDir: '/home/ada/.claude', defaults: { model: 'opus' } },
    { name: 'sam', configDir: '/home/sam/.claude' },
  ],
})
```

## Engines

A profile also selects which **engine** runs the session. `engine: 'claude'` (the default, and
what everything above describes) is Claude Code via the Agent SDK. `engine: 'provider'` runs the
model-agnostic engine instead — no config directory, no CLI process; the server builds it through
the `createEngineRunner` hook, which is where the operator resolves the model and its credentials.

```ts
profiles: [
  { name: 'ada', configDir: '/home/ada/.claude' },
  {
    name: 'kimi',
    engine: 'provider',
    // `apiKeyEnv` names the variable to read. It never holds a key, and no
    // credential ever crosses the wire or lands in a profile response.
    provider: { id: 'moonshotai', model: 'kimi-k3', models: ['kimi-k3'], apiKeyEnv: 'MOONSHOT_API_KEY' },
  },
]
```

The two engines answer to different vocabularies, and the server holds that line rather than
quietly coercing:

- `permissionMode` is Claude Code's vocabulary. A provider session runs `default`,
  `bypassPermissions` and `dontAsk`; asking for `acceptEdits`, `plan` or `auto` under a provider
  profile is a **400**, and a provider profile whose `defaults.permissionMode` is one of those
  fails `createWorkerServer` at startup.
- Provider engines have no equivalent of the CLI's `supportedModels()`, so the model list is
  whatever the operator declared in `provider.models` (falling back to `provider.model` alone).
  A **claude** profile's list can only come from a running CLI, so the server remembers it from
  the `capabilities` of the last session that ran on that profile and reports it back as
  `ProfileInfo.models` / `defaultModel` — enough for a create form to offer a picker rather than
  a text field, without spawning a CLI to ask. Absent until this server has run one session on
  the profile.
- `SessionInfo.engine` reports which engine a live session is actually on, so a dashboard can
  hide affordances that only exist on one side. The bundled one does: resumable SDK sessions,
  setting sources, and the bypass pre-authorization disappear for provider profiles.

### Session grants

A provider profile declares what its sessions get. `createEngineRunner` wires the *backends*
(a search implementation, a fetcher, MCP connections); the profile decides which of them a
session is actually granted, so withholding one is a profile edit rather than a code change:

```ts
{
  name: 'kimi',
  engine: 'provider',
  provider: { id: 'moonshotai', model: 'kimi-k3', apiKeyEnv: 'MOONSHOT_API_KEY' },
  session: {
    capabilities: ['web_fetch', 'deliver_file'], // omit one and its tool is not built at all
    mcpServers: ['deepwiki'],                    // names, resolved against what the host connected
    instructions: 'You evaluate sales leads. …',
  },
}
```

- **Capabilities narrow, never widen.** `POST /sessions` may pass `capabilities` to run with
  fewer than the profile grants. Naming one it doesn't grant is a **400** — refused rather than
  quietly downgraded, so a caller learns instead of wondering where the tool went. Omitting the
  `session` block entirely means "no declaration": the session gets whatever the host wired.
- **MCP servers are named here, never configured.** A transport config's headers can carry
  credentials, and `ProfileInfo` is served by `GET /profiles` — so the configs (and the
  credentials) stay in `createEngineRunner`, and the profile only picks from what the host
  connected. One process-wide connection can serve a mixed fleet this way.
- **A provider session cannot bring its own MCP servers** (400). MCP tools are *authoritative* —
  they run server-side with server credentials and are never bridged to a browser — so honoring
  a client-supplied server would let a caller point an authoritative tool anywhere. Claude
  sessions may still pass `mcpServers`: the CLI spawns those itself, under the operator's own
  config directory.

## Rules

- Profiles are **declared at startup**, and without a `profileStore` (below) the API only reads
  them (`GET /v1/profiles` to list,
  `GET /v1/profiles/:name` for a view-only config snapshot — settings.json highlights, memory,
  skills, agents, commands; env var names only, never values — shown on the dashboard's profile
  detail page). A nonexistent `configDir` fails `createWorkerServer` fast — the CLI would
  otherwise silently start from an empty config.
- With **more than one** profile declared, every `POST /sessions` and `POST /jobs` must name its
  `profile` (400 without one); with **exactly one** it is implicit. The resolved name always
  lands on `SessionInfo.profile` and `JobInfo.profile`, even when implicit.
- **No `profiles` option** → a `default` profile is auto-created from `$CLAUDE_CONFIG_DIR` or
  `~/.claude` when that directory exists, so single-operator deployments need no configuration.
  Pass `[]` to run without profiles (no env pinning at all).
- `defaults` (`model`, `permissionMode`) fill request fields the caller left unset — they are
  defaults, not enforced caps; an explicit request value wins.
- Profile pinning composes with `buildRunnerConfig`: the hook runs first, then the profile's
  `CLAUDE_CONFIG_DIR` is applied on top — the profile wins even if the hook set its own `env`.
  The one exception: when the session env would already land the CLI in the profile's directory
  (the auto-detected `default` profile, typically), nothing is pinned at all — setting
  `CLAUDE_CONFIG_DIR` even to its default value changes where the CLI looks for credentials
  (see [Credentials](#credentials) below).

## Managing profiles from the dashboard

By default the profile set *is* startup config and the API only reads it. Pass a `profileStore`
to let the dashboard create, edit, and delete profiles too:

```ts
import { createFileProfileStore } from '@workerdeck/server'

createWorkerServer({
  authenticate: async (req) => {
    const user = await verifyMyAppToken(req.headers.authorization)
    return user && { allowedProfiles: user.profiles, canManageProfiles: user.isAdmin }
  },
  profiles: [{ name: 'ada', configDir: '/home/ada/.claude' }], // still code, still immutable
  profileStore: createFileProfileStore('/var/lib/workerdeck/profiles.json'),
  allowedConfigDirRoots: ['/Users'], // omit to allow managed provider profiles only
})
```

- **Doubly opt-in.** The operator wires a store *and* the principal carries `canManageProfiles`.
  Without a store the routes answer 404; without the flag, 403.
- **Declared profiles are code.** They are never written to the store, can't be edited or deleted
  over the API (403), and win a name collision. `GET /profiles` marks store-backed ones
  `managed: true` so a UI knows which rows it may touch, and reports `canManage` for the caller.
- **Same validation as startup.** A profile created over HTTP goes through exactly the checks
  `createWorkerServer` would have applied, so the API can't produce one the server would have
  refused to boot with.
- **No renames.** The name is the route, not the body — sessions and jobs are already pinned to it.
- **Managed Claude profiles need `allowedConfigDirRoots`.** A config directory is a credential
  store, so the server bounds which ones a managed profile may point at; unset, only provider
  profiles can be created. Startup-declared profiles are unaffected.
- **`createFileProfileStore` is single-process**, exactly like the bundled queue adapter. Two
  servers sharing one file would race — that is what the seam is for.

Editing grants needs no extra ceiling: a profile can only ever grant capabilities and MCP servers
that `createEngineRunner` already wired, so the server's own code bounds what any edit can reach.

## Access control

The `authenticate` principal may carry `allowedProfiles: string[]`. The server enforces it on
session and job creation (403 otherwise) and filters `GET /profiles` to it, so pickers only
show what the caller may use. On a multi-operator machine this scoping is what keeps one worker
serving several people from degrading into account sharing — give each caller their own
profile(s) rather than a free choice. See
[Auth & Anthropic's terms](/workerdeck/docs/guides/auth/) for why that line matters.

## Credentials

Profiles never touch the credential chain — they only select which config directory the
official CLI reads, via its own `CLAUDE_CONFIG_DIR` mechanism. Two consequences:

- `ANTHROPIC_API_KEY` in the **server's** environment wins for *every* profile (the SDK's
  normal precedence). Per-session provenance stays visible as `apiKeySource` on `SessionInfo`.
- The subscription-credentials notice logs once **per profile**, and `requireApiKey: true`
  fails closed regardless of profile.
- **`CLAUDE_CONFIG_DIR` selects the credential source, not just the config dir.** With the
  variable set, the CLI reads `<dir>/.credentials.json`; unset, it runs its own resolution —
  on macOS that is the login Keychain, where `claude login` stores a claude.ai login. This is
  why the default profile is never pinned, and why a profile pointing at any *other* directory
  needs credentials of its own: run `CLAUDE_CONFIG_DIR=<dir> claude auth login` there, or
  inject a long-lived `CLAUDE_CODE_OAUTH_TOKEN` via `buildRunnerConfig`. The server's
  `checkCredentials` option (on by default in the `workerdeck` CLI) probes each profile
  with `claude auth status` at startup and warns — never fails — when a profile looks
  logged out. Only the logged-in/logged-out verdict is read; no credential or account
  material is touched.

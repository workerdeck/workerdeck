# WorkerDeck

Web-controlled Agent SDK session runner: embed, watch, and control a close-to-real Claude Code
session from a host app; a second, model-agnostic engine runs any AI SDK provider on the same
protocol.

**This file is a dispatcher, not a manual.** It stays under 200 lines (target ~100). Anything
longer than a line or two belongs in `docs/` — never `_docs/`, which is gitignored. Read the
doc for whatever you are about to touch:

- `docs/GOTCHAS.md` — **the invariants that bite.** Skim the headings for whatever you're about
  to touch: engine, permission, parking, bridge, packaging.
- `docs/PACKAGES.md` — **per-package rules you cannot infer from the types.** One `##` section
  per package. Read the section for the package you're changing before you change it.
- `docs/CLIENTS.md` — the VS Code extension, `apps/embedded` (the reference embedding) and the
  iOS app; same shape, one `##` section each.
- `docs/ARCHITECTURE.md` — package map, dependency rule, session/job/parking lifecycles.
- `docs/DEVELOPMENT.md` — tooling (pnpm/turbo/tsgo/oxlint/oxfmt, the `@workerdeck/source`
  condition), and what each package's tests actually cover.
- `docs/CODE-STYLE.md` — the code style rules and what enforces each (oxfmt, oxlint, convention).
  **Read it before writing code, every time, not only when style is the topic** — the rest of this
  list is per-topic; this one applies to every edit. Its § Comments is the rule most often broken
  by pattern-matching on neighbouring code, because the tree still carries pre-rule drift:
  **avoid comments entirely, and prefer `//` over `/**`.**
- `docs/RELEASING.md` — the wrapup checklist, the publish flow, and the release ledger.
- `CONTRIBUTING.md` §Out of scope — non-goals (don't relitigate): serverless hosting, multi-tenant
  SaaS, claude.ai auth. There is no roadmap doc; what's next lives in `_docs/`.

## Package map

Detail for every one of these is in `docs/PACKAGES.md` / `docs/CLIENTS.md`.

| Package | What it is |
| --- | --- |
| `packages/protocol` | Wire types **and the few rules both sides must agree on** (`transcriptActivity`, `transcriptProse`, `transcriptContent`, `replayCoalesceKey`, `snapshotRetains`, `replayRetains`, result truncation, image refs; the sessions-list, unread and usage view models). Dependency-free, browser-safe. Breaking → bump `PROTOCOL_VERSION` (currently **1**: reset just before 1.0.0, and **locked as of that launch** — every breaking change now costs a bump and a mismatch banner). |
| `packages/core` | The engines, shipped as adapters: `SessionRunner` (Claude SDK), `CodexRunner` (codex app-server), `AiSdkRunner` (provider). No transport. |
| `packages/sandbox` | Untrusted-code boundary: QuickJS-NG WASM guest, map VFS, by-value host bridge. Leaf. |
| `packages/queue` | `JobQueue` + `QueueAdapter`. `claimNext` must stay atomic. |
| `packages/server` | HTTP + WS gateway, session registry, profiles, parking/dormancy, scope enforcement, host-filesystem routes. |
| `packages/client` | REST + WS client on platform `fetch`/`WebSocket`. Zero runtime deps. |
| `packages/react` | Headless: `useClaudeSession`, the pure transcript reducer, the replay hold, the companion hooks. |
| `packages/ui` | Styled layer: `SessionPanel`, `SessionWorkspace`, `SessionItem` (the session card, one drawing for every client), the **terminal transcript theme**, the scrubber. Ships source styles; Storybook is its component catalog. |
| `packages/web` | The dashboard. Four sections and a dialog. Prebuilt static, zero runtime deps. |
| `packages/cli` | Published unscoped as **`workerdeck`**. Gateway + dashboard on one port. Hosts the only push credential (APNs). |
| `apps/vscode` | The VS Code extension. No webview draws its own header; no view has screens. |
| `apps/embedded` | The reference embedding — read it before designing another one. |
| `apps/ios` | Native iOS remote control. `WorkerDeckKit/` hand-mirrors protocol + the reducer. |
| `apps/docs` | Astro site → Pages. Keep in sync with README. |

**Dependency direction:** `protocol ← core ← queue ← server ← cli`,
`protocol ← client ← react ← ui ← web`, `sandbox` a leaf either side may use. The browser side
(client/react/ui/apps) must never import core/server, the Agent SDK, or any model SDK;
`client` must never devDep on `react` — that edge is the build-graph cycle turbo refuses.

## Working rules

- **Always `roam index --force` before reading roam's output.** ~4s on this repo; a stale index
  reports against a tree that no longer exists. This is a library monorepo, so `dead_exports` is
  not a defect count — public exports have no in-repo caller.
- `pnpm typecheck|test|build|lint|format`. In-package imports use explicit `.ts` extensions. Dev never
  builds. Releases go through **pnpm only**. Details in `docs/DEVELOPMENT.md`.
- **Read `pnpm lint`'s warnings; never grep it for `error`.** The comment rules report as warnings
  by design (a line count cannot express them), so an error-only filter reports clean while they
  are firing.
- **Never `git push --tags`** — push the one tag by name. A local-only tag from an old cycle will
  publish itself and move every `latest` backwards; `docs/RELEASING.md` has the incident.
- Real-SDK smokes cost tokens and never run in `pnpm test`, but permission-path,
  CLI-control-request and codex process-contract changes need one. See `docs/DEVELOPMENT.md`.
- Docs conventions: `docs/` and `_docs/` are `UPPER-CASE-DASH.md`. `_docs/` is **gitignored**, so
  harvest anything worth keeping out of it before deleting.

## Wrapup

Full checklist and the release ledger in `docs/RELEASING.md`. The short form:

- check: `pnpm lint` + `pnpm typecheck` — test: `pnpm test`
- push: yes — branch `master`, repo is public, every push deploys the docs site.
- version_bump + publish: yes, npm `@workerdeck` org, always through pnpm; push a `v<x.y.z>` tag
  and CI publishes under trusted publishing. Gatekeeper audit first.
- **`package.json` is not the release record** — npm and the *pushed* tags are. Check all three,
  and use `git tag --sort=v:refname` (plain `git tag` sorts lexically).
- co_authored_by: no. frontend_smoke: no (manual).
- **`CLAUDE.md` must stay under 200 lines.** If a change wants to add narrative here, it belongs
  in the matching `docs/` file and gets at most a pointer here.
- docs: keep root `CLAUDE.md` + `README.md` + `docs/` + `apps/docs` in sync.

## Auth red lines (non-negotiable)

WorkerDeck implements NO model-provider auth: credentials are resolved by the official SDK/CLI
from the operator's environment. Never add — and reject any PR that adds — claude.ai OAuth flows
or login UI, subscription-token extraction/storage/forwarding, Claude Code client-identity
spoofing, or multi-account pooling / rate-limit circumvention. Policy enforcement lives in
configuration (`requireApiKey`, the one-time 'oauth' notice, `apiKeySource` on
SessionInfo/system_init), never in tampering with the credential chain. **The same principle
binds the Codex engine**: `codex login` (or `codex login --with-api-key`) is the operator's job
in their own terminal; WorkerDeck never invokes it, never reads `auth.json`, and never wires an
API key into the child or over the app-server's account RPCs — the operator's session env is
passed through whole, but no env key is a credential route on this surface (`CODEX_API_KEY` is
read only by `codex exec`, which we no longer ship; the canary pins that), so availability
comes from `codex login status` alone, and the probe surfaces exit codes and fixed reason
strings only, never `codex login status` output (it contains a masked key fragment). Compliance/legal review is in progress — keep the README "Auth & Anthropic's terms"
section's status honest as things settle; whether OpenAI's terms restrict headless
ChatGPT-subscription codex use the same way is unresolved and mirrors the same posture.

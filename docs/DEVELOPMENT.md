# Development

## Tooling

**Always `roam index --force` before reading roam's output.** It takes ~4s on this repo (493
files, 4.8k symbols), and a stale index is worse than none: it reports metrics against a tree
that no longer exists, and the alerts read as findings about your change when they predate it.
One caveat when you do read it — this is a library monorepo, so a package's *public* exports
have no in-repo caller and roam scores them as `dead_exports`. That number is not a defect
count.

pnpm workspace + turbo (`pnpm typecheck|test|build|lint`); typecheck is `tsgo` (TS 7 preview) and
covers `smoke/` + `examples/` too via `typecheck:extras` (they have tsconfigs but aren't packages,
so turbo never ran them — one consequence bites the browser packages: `smoke/tsconfig.json` is
`lib: ["ES2022"]` with no DOM and `smoke/sdk-client.ts` imports `@workerdeck/react`, which the
`@workerdeck/source` condition resolves to **source**, so a browser package's `src/` may not name
`document`, `createImageBitmap` or any other DOM global directly — even though its own tsconfig
has the DOM lib — and reaches them through `globalThis` with a structural type instead
(`use-attachments.ts`, `use-profile-usage.ts`). Feature-detection is what the runtime needs
anyway; the type error is what makes it non-optional); lint oxlint (`.oxlintrc.json` — it must keep that exact name or oxlint
silently runs on defaults); format oxfmt (`.oxfmtrc.json`, `pnpm format`, format-on-save via the
`oxc.oxc-vscode` extension — rules and rationale in `docs/CODE-STYLE.md`); `build/` via tsdown
only on `prepack`/CI. Dev never builds
— the `@workerdeck/source` export condition resolves packages to `src/index.ts` (Node runs with
`--conditions=@workerdeck/source` + swc-node; Vite/vitest set `resolve.conditions`, vitest also
aliases). `pnpm start:prod` is the other side of that coin and the surface to judge a release
candidate on: `pnpm build` then the built `packages/cli/build/cli.mjs` with **no** conditions
flag, so imports resolve to each package's `build/` and the dashboard is `@workerdeck/web`'s
prebuilt `dist/` — production React, not development. It runs on 8788 with state in `/tmp`
(`examples/prod-server.config.mjs`), deliberately beside `dev:server` on 8787 rather than
replacing it, so the two can be compared without stopping either. The difference is not
academic: measured on one 976-row session at a pinned width, dev and prod share a p50 but dev's
p95 is ~2× prod's (~21ms vs ~11ms) — all of it dev-mode React in the tail.
**A `dev` script that runs two watchers must run them under one supervisor, never `a & b`.**
`apps/vscode` used `node esbuild.mjs --watch & vite build --watch`: the `&` backgrounds the first
watcher *inside* the `sh -c`, so when turbo (or the terminal) went away the shell and the vite half
died and esbuild was reparented to init. It leaked exactly one orphaned watcher — each still
holding an `esbuild --service` child — per `pnpm dev` run, and four had accumulated over three days
before anyone noticed. Both multi-watcher packages now use `concurrently`, which forwards the
signal to its children; the check is one line: start `pnpm dev`, kill the `pnpm` pid, then
`ps -eo pid,ppid,command | grep esbuild` and expect nothing.

**`packages/ui` has two browser harnesses and they answer different questions.** `pnpm storybook`
(port 6006, `storybook:build` for a static copy) is the **component catalog**: does every state of
a component look right, in both themes, at the width it ships at. `packages/ui/dev/` (`pnpm dev`,
port 5193) is unchanged and stays the **measurement** harness for the terminal renderer — the
character-cell overlay (`dev/grid-audit.ts`), the height audit against real DOM
(`dev/height-audit.ts`), the scroll perf sweep (`dev/perf-audit.ts`) — which are questions about
one running surface, not about a component's states, and which `dev/` could only have answered
for components by growing a second app inside itself. `.storybook/main.ts` resolves the `@workerdeck/source`
condition like every other dev entry, so there is no build step between an edit and the story;
`.storybook/preview.tsx` puts **theme** (dark/light, set on `document.documentElement.dataset.theme`
because half the tokens are declared on `:root` and would not follow a scoped wrapper) and
**surface** (sidebar/editor/panel, since a card's fills were picked against the sidebar and
reviewing one on the page's default ground is reviewing it against a colour it never ships on) in
the toolbar as globals rather than as story args. Stories live in `stories/` and are framed at
**310px** — the auxiliary bar's width, and near enough every sidebar's — because what truncates
first is a list card's whole difficulty and a card reviewed at 900px was never asked its hardest
question. Both harnesses are dev-only and **unpublished**: `files` is `build` + `src`, and
`storybook-static/` is gitignored. `tsconfig.json`'s `include` covers `stories/**` and
`.storybook/**`, so a broken story fails `pnpm typecheck` rather than only at 6006. The
`Sessions/SessionItem` stories carry the **selection model** in full — one story per fill (nothing,
session, sub-agent, and a task key that must change nothing), plus `Selection · interactive`, which
is wired to real state and prints what a host would have received, because three fills and two
grains is a thing to click through rather than to read a table about.

In-package imports use explicit `.ts` extensions. Releases go through **pnpm only** —
`npm publish` would ship `workspace:*` verbatim; see the packaging section of `docs/GOTCHAS.md`
before touching versioning or the publish workflow.

## Testing

`pnpm test` — core: fake `queryFn` harness (no CLI spawn) + a scripted JSON-RPC peer
(`connectFn`) for `CodexRunner`; server: real HTTP+WS integration incl. job routes + webhook
receiver (codex via the test-only `engines` adapter override); queue: fake runner; react:
reducer + bridge e2e — it carries **no jsdom and renders nothing**, the same split `ui` makes
below and for the same reason, so a hook's decisions are extracted into pure modules and pinned
there instead (`lib/attach-plan.ts`'s `planAttach`/`shouldWriteParting` are the whole of
`useClaudeSession`'s attach effect as values: seed-or-hold, warm-read gating, `afterSeq`, the
parting write-back). A test here that wants to render is a decision that has not been extracted
yet; **ui: the pure modules only, and deliberately so** — the terminal theme's
*geometry* needs real text layout, which jsdom does not have, so it is gated by
`dev/height-audit.ts` in a browser instead, while everything that is a string-or-array contract
(`terminalBlocks`, `runSummary`/`toolFamily`/`foldsTogether`, `collapsedResult`, `buildClusters`,
`textLines`) is unit-tested with no DOM at all. That split is the rule for anything added here: a
test in `packages/ui/test` that wanted a DOM belongs in the playground audit. `buildClusters` and
`railScale` are exported *for the test alone* (not from `index.ts`) — both have shipped pure-logic
bugs, which is the whole argument.
Real-SDK smokes cost tokens and never run in `pnpm test`, but permission-path or
CLI-control-request changes need one — the fake harness can't validate those payloads — and **an
engine's process contract can't either**: any change to `CodexRunner`'s spawn options,
handshake, or event mapping needs `pnpm smoke:codex`. Smokes live in `smoke/`: `smoke:sandbox` and
`smoke:codex --canary` are free; `smoke:live`, `smoke:sdk`, `smoke:media` (the only check that
the CLI accepts image/PDF/text attachment blocks at all) and the full `smoke:codex` are not.
Three more the list above omits. `smoke:mcp --probe` is **free** — it connects to the real
DeepWiki server, asserts the tools come back namespaced, and exits before touching a model;
without `--probe` it grants those tools to a real session and costs tokens. `smoke:restart` spawns
its **own** gateway on its own port and state dir (never the one you are running) and is the only
thing that shows a real `claude`/`codex` resume works — `server/test/dormant.test.ts` drives a fake
engine, so it proves the record and the routes, not the feature. `smoke:attach` costs nothing and
attaches to a session that already exists: **run it before calling any new replay rule finished.**
It keeps text and non-text parts apart, which is the measurement `truncateResults` shipped
without, and `--capture <file>` dumps every frame as JSONL so a control session can be diffed
byte-for-byte across a rule change.
**Anything touching the APNs payload, the device route or the app's tap handling needs
`pnpm smoke:push`** — it costs no tokens, but it is the only way to raise a notification without
waiting for a session to decide to, and a tap is the only gate the delegate's main-thread contract
has (`docs/GOTCHAS.md`, §APNs push).


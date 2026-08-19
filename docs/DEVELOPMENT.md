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
so turbo never ran them); lint oxlint; `build/` via tsdown only on `prepack`/CI. Dev never builds
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
In-package imports use explicit `.ts` extensions. Releases go through **pnpm only** —
`npm publish` would ship `workspace:*` verbatim; see the packaging section of `docs/GOTCHAS.md`
before touching versioning or the publish workflow.

## Testing

`pnpm test` — core: fake `queryFn` harness (no CLI spawn) + a scripted JSON-RPC peer
(`connectFn`) for `CodexRunner`; server: real HTTP+WS integration incl. job routes + webhook
receiver (codex via the test-only `engines` adapter override); queue: fake runner; react:
reducer + bridge e2e; **ui: the pure modules only, and deliberately so** — the terminal theme's
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


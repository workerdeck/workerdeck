# Contributing

Thanks for looking. WorkerDeck is early, so the most useful contributions right now are bug
reports with a reproduction, and PRs that stay inside one package's boundary.

## Getting set up

```bash
pnpm install
pnpm server   # gateway + dashboard on http://127.0.0.1:8787, no auth (loopback only!)
pnpm web      # optional: vite dashboard on :5191 with HMR, proxying /v1 to the gateway
```

`pnpm server` is the real `workerdeck` CLI pointed at
[`examples/dev-server.config.mjs`](examples/dev-server.config.mjs) — there is no separate dev
entry point, so what you develop against and what `npx workerdeck` ships are one code path.
Edit that config directly; flags still win (`pnpm server --port 9000`). The dashboard is the one
thing that must be compiled, so the script builds it first (`pnpm dashboard`, turbo-cached); run
`pnpm web` alongside when you want HMR.

To reach the gateway from another device — a phone on the same Tailscale network, say — bind a
routable interface:

```bash
pnpm server --host 0.0.0.0
```

Auth off loopback is not optional: anyone who can reach the port would get a Claude Code
session. Pass `--auth-key <secret>`, or let the CLI generate one — printed once, kept in the
state dir, reused on later starts. Native clients send it as `Authorization: Bearer <key>`;
browsers post it once at the login page and ride a cookie. To genuinely serve without auth on a
trusted network, declare the bind host (`--insecure-host <name>`, config `insecureHosts`) — the
declared name doubles as an accepted Host header.

Nothing else needs building: apps and tests resolve packages straight to TypeScript source
through the `@workerdeck/source` export condition, and `build/` output exists only for
publishing. In-package imports use explicit `.ts` extensions.

```bash
pnpm typecheck   # tsgo (TypeScript 7 native preview), workspace + smoke/ + examples/
pnpm test        # vitest
pnpm lint        # oxlint
```

`pnpm test` uses fakes throughout — a fake `queryFn` for the Claude runner, a real HTTP+WS
integration suite for the server, a fake runner for the queue. It spawns no CLI and spends no
tokens. The real-SDK smokes in `smoke/` do cost tokens and deliberately never run in `pnpm test`;
if you change a permission path or a CLI control request, run one anyway, because the fake harness
cannot validate those payloads.

## Before you open a PR

Read [`docs/architecture.md`](docs/architecture.md) for the package map and the dependency rule,
and skim the relevant headings of [`docs/gotchas.md`](docs/gotchas.md) — it documents the
invariants that bite, which is usually the difference between a patch that works and a patch that
looks like it works.

Two rules the review will hold you to:

- **The dependency direction.** `protocol ← core ← queue ← server ← cli` and
  `protocol ← client ← react ← ui ← web`, with `sandbox` a leaf either side may use. The browser
  side must never import core, server, the Agent SDK, or any model SDK; the wire protocol is the
  only bridge. Anything a client needs must be expressible as protocol events and commands.
- **Breaking the wire means bumping the wire.** A breaking change to
  `@workerdeck/protocol` bumps `PROTOCOL_VERSION`, and new client-visible frames need matching
  `SessionHandle` surface in `@workerdeck/client`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat(server): …`, `fix(core): …`, `docs: …`).

## Auth red lines

WorkerDeck implements **no Anthropic authentication of its own**, by design: credentials are
resolved by the official SDK/CLI from the operator's environment. PRs that cross these lines will
be rejected regardless of quality:

- no claude.ai OAuth flows or login UI,
- no extraction, storage, or forwarding of subscription tokens,
- no spoofing of Claude Code's client identity,
- no multi-account pooling or rate-limit circumvention of any kind.

Policy enforcement lives in configuration (`requireApiKey`, the one-time subscription notice,
`apiKeySource` on `SessionInfo`), never in tampering with the credential chain. Background:
[Auth & Anthropic's terms](https://workerdeck.github.io/workerdeck/docs/guides/auth/).

## Out of scope

Settled non-goals — please don't open PRs re-litigating them: serverless hosting (the SDK spawns a
long-running subprocess with filesystem state), multi-tenant SaaS, and claude.ai authentication.
See the [roadmap](docs/roadmap.md) for what *is* wanted next.

## Security

Don't file security issues as public GitHub issues — see [SECURITY.md](SECURITY.md).

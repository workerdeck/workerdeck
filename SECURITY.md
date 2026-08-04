# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/workerdeck/workerdeck/security/advisories/new)
(the **Security** tab → *Report a vulnerability*) rather than as a public issue. Include what an
attacker gains, how to reproduce it, and the affected version.

This is a small project with no dedicated security team. Expect a first response within a few days,
and a fix released as a patch version once confirmed. Please give us a chance to ship it before
disclosing publicly.

## Supported versions

Only the latest published minor is supported. Fixes land on `master` and go out as a new patch
release; there are no long-lived maintenance branches yet.

## Threat model — what WorkerDeck assumes

A worker runs tool-wielding agent sessions against real directories. Anyone who can reach the
gateway, and is authorized by it, can effectively run code on the host. That is the point of the
software, so it is not a vulnerability by itself. What *is* in scope:

- **Authentication or authorization bypass** — reaching a session, job, profile, or file route
  without satisfying the `authenticate` hook or the instance's `--auth-key`; attaching to someone
  else's session; a cross-site page attaching a WebSocket (the `Origin` check); DNS rebinding
  against the unauthenticated loopback default.
- **Escaping a declared boundary** — `allowedCwdRoots`, `allowedConfigDirRoots`,
  `allowedTools`/`disallowedTools`, `disableBypassPermissions`, or a profile's granted
  capabilities not holding; a session request widening what its profile grants.
- **Permission-system bypass** — a tool call that should have surfaced as an approval executing
  without one, or an approval being resolvable by a party that shouldn't be able to.
- **Sandbox escape** — untrusted code in the QuickJS guest reaching the host filesystem, network,
  or process; escaping the interpreter's memory or time limits; a bridged (`eval_script`)
  execution reaching an *authoritative* tool.
- **Credential exposure** — a credential appearing in a protocol event, a REST response, a
  `ProfileInfo`, a log line, or a parked-session record.
- **Deferred-execution abuse** — delivering a result for an `executionId` you shouldn't be able
  to, or replaying one to apply twice.

Out of scope, because they are documented properties rather than defects:

- An **unauthenticated instance** you deliberately exposed with `--insecure` or
  `allowUnauthenticated: true`.
- A session doing damage **within** the roots and permission mode it was granted — including
  anything under `bypassPermissions` or `dontAsk`.
- The **parked-session directory** and the SDK's own transcript store holding plaintext
  transcripts. Protect them like `~/.claude/projects`.
- **Shared-secret auth not establishing identity.** `--auth-key` is a door key; put an
  identity-aware proxy in front if you need to know who is on the other end.
- Anything requiring **operator-level access** to the host or its environment variables.

## What WorkerDeck never touches

It performs no Anthropic authentication of its own: the official SDK/CLI resolves credentials from
the operator's environment. It never implements claude.ai OAuth, never reads, stores, or proxies
tokens, and never touches `~/.claude` credentials. A report that WorkerDeck mishandles Anthropic
credentials is very much in scope — see
[Auth & Anthropic's terms](https://workerdeck.github.io/workerdeck/docs/guides/auth/).

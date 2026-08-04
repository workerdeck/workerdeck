---
title: Auth & Anthropic's terms
description: WorkerDeck performs no Anthropic authentication of its own — what that means for operators and contributors.
order: 7
---

**WorkerDeck performs no Anthropic authentication of its own — by design.** It spawns the
official Agent SDK, which spawns the official Claude Code CLI, which resolves whatever
credentials the *operator's* environment provides: `ANTHROPIC_API_KEY`, Bedrock/Vertex platform
auth, or the operator's own stored `claude login`. WorkerDeck never implements claude.ai
OAuth, never reads, stores, or proxies tokens, and never touches `~/.claude` credentials. Which
credentials your deployment uses — and whether that use complies with
[Anthropic's terms](https://www.anthropic.com/legal/consumer-terms) — is the operator's
responsibility.

## Where we understand the lines to be

Not legal advice:

- **API key (or Bedrock/Vertex) is the supported path** for anything that is a service:
  unattended/scheduled runs, multi-user deployments, anything you expose to others. Anthropic's
  Agent SDK docs are explicit that third-party developers may not offer claude.ai login or
  subscription rate limits in their products; the Consumer Terms restrict automated access
  except via API key. Set `ANTHROPIC_API_KEY` in the server environment, and consider
  `requireApiKey: true` on `createWorkerServer` to **fail closed**: sessions that initialize on
  subscription credentials (`apiKeySource: 'oauth'`) are terminated with an error.
- **Your own subscription, your own single-user use** (the equivalent of running `claude -p`
  yourself) is the one case where subscription credentials may be appropriate. Without
  `requireApiKey`, the server allows it but logs a one-time notice; the auth provenance is also
  visible per session as `apiKeySource` on `SessionInfo` and the `system_init` event.

## requireApiKey: fail closed

```ts
const worker = createWorkerServer({
  authenticate,
  requireApiKey: true, // recommended for services and any unattended use
})
```

Each session's credential provenance surfaces as `apiKeySource` on `SessionInfo` and the
`system_init` event; `'oauth'` means claude.ai subscription credentials, other values
(`'user' | 'project' | 'org' | 'temporary'`) are API-key provenance. With
`requireApiKey: true`, an `'oauth'` session is terminated with a `session_error` telling the
operator to set `ANTHROPIC_API_KEY` (or Bedrock/Vertex auth). Without it, the server logs a
one-time notice instead — appropriate only for personal single-user deployments.

## Profiles on shared machines

[Profiles](/workerdeck/docs/guides/profiles/) let one worker serve several operators, each
under their own Claude Code config dir — selected via the CLI's own `CLAUDE_CONFIG_DIR`
mechanism, never by touching the credential chain. The auth-relevant part: **scope profiles per
caller** with `allowedProfiles` on the `authenticate` principal. A shared dashboard where anyone
may run under anyone's account is multi-account pooling — exactly the red line below — while
each person running under their own profile is just each person using their own account. The
subscription notice logs per profile, and `apiKeySource` shows what each session actually used.

## Gateway auth is a separate thing entirely

Everything above is about *Anthropic* credentials. Guarding the gateway itself — deciding who may
reach it at all — is your own concern, and the two never mix.

For an embedded deployment that is the `authenticate` hook: it gets the raw request and returns a
principal or nothing, and it guards REST **and** the WebSocket upgrade. For the turnkey
[`workerdeck`](https://www.npmjs.com/package/workerdeck) instance it is `--auth-key`, one
shared secret over two transports — a login page trades it for an `HttpOnly` cookie for browsers,
while services send it as a header. Bound off loopback with no key supplied, the instance
generates one and stores it under its state dir rather than serving open; the explicit opt-outs
(`--insecure`, `insecureHosts`) are covered in
[Run an instance](/workerdeck/docs/getting-started/run-an-instance/#protecting-it).

That split isn't arbitrary. **A browser cannot set a header on a WebSocket handshake**; the
constructor takes a URL and subprotocols and nothing else. So a browser-facing deployment has
three options and only three: a cookie (sent automatically on a same-origin upgrade), a
query-string ticket (`ClientOptions.buildWsUrl` exists for this, but something has to issue the
ticket), or a proxy that stamps the credential server-side on the tab's behalf. Embedding a key in
the served JavaScript is not one of them.

If you take the cookie route, remember that WebSocket upgrades are **exempt from CORS** — an
explicit `Origin` check, not `SameSite` alone, is what actually defends an attach against a
cross-site page. And note that none of this establishes *identity*: a shared secret is a door key.
Put an identity-aware proxy in front if you need to know who is on the other end.

## Compliance status: under review

We are still working through greenlighting the compliance and legal posture of this project —
with our own legal/compliance specialists and, where appropriate, explicit approval from
Anthropic (whose Agent SDK docs provide for previously-approved exceptions). Until that
concludes, treat the guidance above as our good-faith reading, not a settled position, and do
your own diligence.

## Red lines for contributors

PRs crossing these will be rejected:

- no claude.ai OAuth flows or login UI,
- no extraction/storage/forwarding of subscription tokens,
- no spoofing of Claude Code's client identity,
- no multi-account pooling or rate-limit circumvention of any kind.

The auth layer stays 100% Anthropic-owned code. Policy enforcement lives in configuration
(`requireApiKey`, the one-time notice, `apiKeySource` visibility), never in tampering with the
credential chain.

## Related

- [Deployment](/workerdeck/docs/guides/deployment/) — the host-app auth hook
  (`authenticate`), which is a separate concern from Anthropic credentials.
- [Server reference](/workerdeck/docs/reference/server/) — `requireApiKey` and the rest of
  the options.

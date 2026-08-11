---
title: Run an instance
description: npx workerdeck — the session gateway and the full dashboard on one port, with nothing to clone.
order: 2
---

If you want WorkerDeck *running* rather than embedded, there is nothing to clone:

```bash
npx workerdeck
```

That serves `http://127.0.0.1:8787` — the dashboard at the root, the API under `/v1` — and
persists parked sessions under `~/.workerdeck` so a restart doesn't drop them. Anthropic
credentials come from your environment, exactly as they would for `claude` in a terminal; see
[Auth & the providers' terms](/workerdeck/docs/guides/auth/).

The `@workerdeck/*` packages are the libraries you embed. This one — the unscoped
[`workerdeck`](https://www.npmjs.com/package/workerdeck) — is the service you run.

## Protecting it

```bash
npx workerdeck --host 0.0.0.0 --auth-key "$SECRET" --cwd-root ~/projects
```

One secret, two transports:

- **Browsers** get a login page, trade the secret for an `HttpOnly` session cookie, and use that
  for everything afterwards — including the WebSocket attach.
- **Services** send the same secret as an `x-workerdeck-key` header (or
  `Authorization: Bearer`).

The cookie is not a convenience. A browser cannot set a header on a WebSocket handshake at all, so
a cookie is the only credential a tab can present when it attaches to a session — and a cookie
only rides requests to the origin that set it. That is why the dashboard and the API share a port,
and why an explicit `Origin` check (not `SameSite` alone) guards the upgrade: WebSocket upgrades
are exempt from CORS.

Neither transport establishes *who* the person is; the secret is a door key. Put an
identity-aware proxy in front if you need more than that.

**Off loopback, auth is not optional — but the key is.** An unauthenticated gateway on a
routable interface is a coding agent shell for anyone who can reach the port, so binding one
without `--auth-key` generates a key instead of serving open: printed once at first start,
stored in `<state-dir>/auth-key` (mode 600), and reused silently on later starts — a restart
doesn't un-pair the clients that saved it. With `--no-parking-store` there is nowhere to keep
it, so the key is ephemeral per run and the banner says so.

Mind where that lands. The state dir defaults to `~/.workerdeck`, but *beside the config
file* whenever there is one — so a `workerdeck.config.mjs` checked into a repo puts the key,
and the plaintext parked transcripts next to it, inside that repo. Add `.workerdeck/` to its
`.gitignore`, or point `--state-dir` somewhere outside the working tree.

Two explicit opt-outs actually serve without auth. `--insecure` is the blanket one, for when
something in front is doing the authenticating. `--insecure-host <name>` (repeatable; config:
`insecureHosts`) is the narrow one — a declaration that *this* bind host may run open. One
declaration covers both roles: it waives the key for that bind host *and* is accepted as a Host
header, so `workerdeck --host toby --insecure-host toby` needs nothing else. Entries name a
host, never an endpoint (a port is rejected), and match the bind host literally — `0.0.0.0`
means the all-interfaces bind itself, not "any host". The Host-header fence stays up either way:
an unauthenticated instance answers only to loopback names plus what you declared, which is what
stands between it and DNS rebinding.

Behind TLS termination, add `--trust-proxy` — otherwise the session cookie loses its `Secure`
flag and the origin check computes `http://` where the browser says `https://`.

## Browsing the host's files

```bash
npx workerdeck --cwd-root ~/projects --fs-write
```

`/v1/fs/*` lets a client — the iOS app, or anything holding the key — list directories, read
files, and search them (which is what backs `@file` completion in the app's composer).

**Reading follows `--cwd-root` and needs no flag of its own.** You could already start a session
in one of those directories and ask the agent to print any file in it, so serving the same trees
directly adds no authority — it just removes the absurdity of going through a language model to
read a file. `--fs-root` exists to *narrow* that (or to expose a tree sessions may not run in);
with neither flag the routes 404, because "a session may run anywhere" is a statement about paths
you type at a keyboard, not a licence to serve `/` to the network.

**Writing is the part that isn't implied**, hence `--fs-write`: an agent's edits go through the
permission flow and a `PUT` does not. Writes are still always conditional — a client sends the hash
of what it read, and a file the agent changed in the meantime is a 409 rather than a silent
clobber.

A root is the whole trust boundary either way. The agent writes into these directories, so
containment is decided on the resolved real path — a symlink pointing at `~/.ssh` is refused, not
followed — but everything genuinely *inside* a root is readable. Point it at your projects, not
your home directory.

## Options

| Flag | Env | Default |
| --- | --- | --- |
| `--port <n>` | `WORKERDECK_PORT` | `8787` |
| `--host <addr>` | `WORKERDECK_HOST` | `127.0.0.1` |
| `--auth-key <secret>` | `WORKERDECK_AUTH_KEY` | none — no auth on loopback, generated elsewhere |
| `--cwd-root <path>` (repeatable) | `WORKERDECK_CWD_ROOTS` (`:`-separated) | unrestricted |
| `--fs-root <path>` (repeatable) | `WORKERDECK_FS_ROOTS` (`:`-separated) | narrows `/v1/fs`; unset, reading follows `--cwd-root` |
| `--fs-write` | — | off (read-only) |
| `--profile <name=dir>` (repeatable) | — | auto-detected from `~/.claude` |
| `--state-dir <path>` | `WORKERDECK_STATE_DIR` | beside the config file, else `~/.workerdeck` |
| `--trust-proxy` | — | off |
| `--allowed-origin <o>` / `--allowed-host <name>` (repeatable) | — | loopback names only |
| `--insecure-host <name>` (repeatable) | — | none (config: `insecureHosts`) |
| `--no-parking-store` | — | durable parking on |
| `--config <path>` | — | `./workerdeck.config.mjs` |
| `--insecure`, `--open`, `--help`, `--version` | | |

Precedence is narrowest-wins: flags > env > config file > defaults.

## The config file

`authenticate`, `buildRunnerConfig` and `createEngineRunner` are functions, so they can't come
from a flag. `workerdeck.config.mjs` default-exports the
[`createWorkerServer` options](/workerdeck/docs/reference/server/) — or a function, sync or
async, returning them:

```js
export default {
  allowedCwdRoots: ['/srv/projects'],
  profiles: [{ name: 'me', configDir: '/home/me/.claude' }],
  requireApiKey: true,
  buildRunnerConfig: (req) => ({ ...req, env: { ...process.env, CI: '1' } }),
}
```

Supplying your own `authenticate` turns the built-in shared-secret auth **off entirely** — one
hook, one scheme, rather than two paths where only one got audited. If you take it over, you own
finding a credential the browser can actually present (see above: cookie, query-string ticket, or
a proxy that stamps it server-side).

## Mounting behind a proxy

The dashboard's assets resolve from an absolute `/assets/…`, so it must be served at a **domain
root**, not a subpath — a dedicated vhost reverse-proxying to the instance is the intended shape.
The dashboard itself is [`@workerdeck/web`](https://www.npmjs.com/package/@workerdeck/web),
an ordinary dependency of the CLI; point `webRoot` at your own build to serve a fork instead.

## Restarting safely

```bash
npx workerdeck guard --wait 300 --allow-parked && systemctl restart workerdeck
```

Exits `0` when a restart is safe, `1` while a session is mid-turn, awaiting an approval, or parked
without durability behind it, and `2` when it couldn't tell — never treating "couldn't tell" as
safe. Details, including `--allow-queued` and authenticating against a custom `authenticate` hook,
are in [Deployment](/workerdeck/docs/guides/deployment/#restarts-parked-sessions-and-the-deploy-guard).

## Where to go next

- [Quickstart](/workerdeck/docs/getting-started/quickstart/) — create a first session, then
  embed the panel in your own app.
- [Permissions](/workerdeck/docs/guides/permissions/) — the approval flow you'll be clicking
  through.
- [Profiles](/workerdeck/docs/guides/profiles/) — what a session runs as, and how to run one
  worker for several people.

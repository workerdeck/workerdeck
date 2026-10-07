---
title: Cross-gateway peers
description: Let agents on separate machines list, peek at and message each other through one relay.
order: 12
---

Every session already gets `peers_list`, `peers_peek` and `peers_send` for the other sessions on
its own gateway. A **relay** extends that across machines: run one on an always-on device, point
each gateway at it, and sessions on the other gateways show up in `peers_list` with ids of the
form `gateway:session`.

```
gateway A ──ws──┐
gateway B ──ws──┼──> relay (registry, auth, rules, routing)
gateway C ──ws──┘
```

Gateways only dial out, so only the relay has to be reachable (a tailnet, a LAN, or a reverse
proxy).

## 1. Run the relay

```bash
workerdeck relay serve --host 0.0.0.0 --port 7777
# or the standalone package: npx @workerdeck/relay serve ...
```

TLS is optional: `--tls-cert` and `--tls-key` serve `wss://`. Without them the relay serves plain
`ws://` and warns when bound off loopback, since each gateway's key crosses the network in its
first frame. A tailnet or a TLS-terminating proxy covers that.

## 2. Enroll each gateway

```bash
workerdeck relay enroll mac-mini
```

This prints the gateway's key **once**; the relay keeps only a hash. Save it on that gateway, for
example in `~/.workerdeck/relay.key` with mode 0600. `workerdeck relay revoke <name>` removes a
gateway; a running relay disconnects it within seconds. `workerdeck relay status` lists who is
online.

## 3. Write the rules

The relay denies everything until a rule allows it. Rules live in `~/.workerdeck/relay/rules.json`
and are reloaded on change:

```json
{
  "rules": [
    { "from": "mac-mini", "to": "pi" },
    { "from": "*", "to": "build-box", "allow": ["send"], "scope": { "projects": ["/srv/ci"] } }
  ]
}
```

- `from` and `to` are gateway names or `*`.
- `allow` defaults to `["send", "peek"]`.
- `scope.projects` limits a rule to sessions whose cwd or project root is under one of the paths.

## 4. Point each gateway at the relay

In the gateway's `workerdeck.config.mjs`:

```js
export default {
  relay: {
    url: 'ws://relay.tailnet.ts.net:7777',
    gateway: 'mac-mini',
    keyFile: '~/.workerdeck/relay.key',
    expose: { allow: ['send', 'peek'] },
  },
}
```

`WORKERDECK_RELAY_KEY` works in place of `keyFile`; the CLI removes it from the environment before
any agent or shell starts. `expose` is the gateway's own ceiling, and the relay cannot widen it:
`expose.scope` limits which sessions are published at all (same shape as a session scope), and
`expose.allow` limits which operations this gateway accepts from others. `caFile` trusts a
self-signed relay certificate.

## What the agents see

`peers_list` rows for remote sessions carry `gateway`, the full `cwd`, project, model, context
usage and status, plus `allow`, which says whether the caller may send to or peek at them. A
message from another gateway arrives framed as coming from that gateway, and the transcript shows
the sender as `Name@gateway`. The same guards apply as locally (16k characters, 10 messages a
minute per pair, a 12-hop chain that a human turn resets), enforced by both the relay and the
receiving gateway. If the relay is unreachable, `peers_list` still returns the local sessions and
says remote gateways are unavailable.

A session with a `scope` never reaches past its own gateway.

## Teams across gateways

An agent can join a lead on another gateway: drag it onto the lead in the dashboard or VS Code
(both gateways must be configured in that client and online at the relay). The lead's gateway
records an invitation, the member's gateway joins under it, and the member then reaches its lead
and teammates wherever they run. Both gateways need `team` in `expose.allow` and a rule that
grants it:

```json
{ "rules": [{ "from": "*", "to": "*", "allow": ["send", "peek", "team"] }] }
```

A gateway can waive the per-join invitation for agents of the same owner from gateways it trusts:
`relay: { ..., teams: { acceptFrom: ['laptop', 'win-desktop'] } }`.

The lead's gateway is the authority on who is in its team; the member's gateway decides whether
its agent is in one. A gateway that drops off the relay keeps its teams restricted, never widened,
and only an answer from the other gateway dissolves a membership.

## Owners: sharing a relay with colleagues

Every gateway, session and agent has an **owner**: a label for whom it answers to, such as
`tobias`, `ruli` or an organisation. It is not a login and has nothing to do with model
credentials. Agents of different owners never see each other unless one of these holds:

- they are in the same team (lending an agent to a colleague's team asks for confirmation), or
- both are **shared** top-level agents: each appears as a card in the other's lists, and they can
  message each other, never peek. Members and plain sessions are never shared.

An agent is **Private** by default. Choose Private or Shared in *New agent* or the agent's `⋯`
menu; the gateway's default is `--agent-sharing private|shared` (config `agentSharing.default`),
and `--agent-sharing never` shares nothing. An agent whose session runs without permission
prompts (`bypassPermissions`, `dontAsk`) receives nothing from other owners.

Enroll each gateway with its owner, and give a gateway several people use each owner it may claim:

```bash
workerdeck relay enroll laptop --owner tobias
workerdeck relay enroll mini --owners silkweave,tobias,ruli,dan
```

On a gateway with several owners, each profile names its owner in the config
(`profiles: [{ name: 'ruli:claude', ..., owner: 'ruli' }]`) and `--owner <label>` (config `owner`)
covers the rest. Such a gateway refuses to start a session that resolves to no owner. Rules
between gateways of different owners need `"crossOperator": true`; a rule without it covers
same-owner pairs only:

```json
{ "from": "*", "to": "*", "allow": ["send", "team"], "crossOperator": true }
```

What this does not protect against:

- **The relay is trusted.** Gateways check each other's claims, but a compromised relay can
  forge any of them. Run it on a tailnet or behind TLS, for people you trust.
- **Owners separate agents, not people.** Everyone who holds a gateway's auth key can act for
  every owner on it, and a gateway enrolled with several owners can speak for all of them.
  Enroll the smallest set.

## Running the relay as a service

The relay belongs on a machine that stays up, under a service manager that restarts it. The
setup below is the recommended one: the relay listens on loopback only, and a TLS reverse proxy on
the same machine is what the other gateways reach.

### State

Give the relay a state dir of its own and pass the same `--state-dir` to every `serve`, `enroll`,
`revoke` and `list` (or set `WORKERDECK_RELAY_STATE_DIR`); a command run without it reads
`~/.workerdeck/relay` instead. `rules.json` goes in that directory.

```bash
mkdir -p /srv/relay && chmod 700 /srv/relay
```

### launchd (macOS)

`~/Library/LaunchAgents/dev.workerdeck.relay.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.workerdeck.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/opt/homebrew/bin/workerdeck</string>
    <string>relay</string>
    <string>serve</string>
    <string>--state-dir</string><string>/srv/relay</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>7777</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/srv/relay/relay.log</string>
  <key>StandardErrorPath</key><string>/srv/relay/relay.log</string>
</dict>
</plist>
```

launchd does not read your shell profile, so nothing is on `PATH`: name `node` and the
`workerdeck` script by absolute path (`which node workerdeck`). A Homebrew `node` keeps its path
across upgrades; an nvm or fnm path changes with every Node version and breaks the plist on the
next upgrade. Load it with `launchctl bootstrap gui/$(id -u) <plist>`, and after an edit run
`launchctl kickstart -k gui/$(id -u)/dev.workerdeck.relay`. A LaunchAgent runs as you and only
while you are logged in; a machine that must serve with nobody logged in needs a LaunchDaemon
with `UserName`. On Linux the same shape is a systemd unit with `Restart=always`.

### TLS: a reverse proxy, or `--tls-cert`

A proxy that already holds a certificate it renews is the simpler option. It terminates TLS and
forwards to the loopback relay; the WebSocket upgrade passes through untouched, and the relay
accepts it on any path. With Caddy:

```text
relay.example.com {
	reverse_proxy 127.0.0.1:7777
}
```

Remote gateways then dial `wss://relay.example.com`; a publicly trusted certificate needs no
`caFile`. A gateway on the relay's own machine dials `ws://127.0.0.1:7777` and skips the proxy.

`--tls-cert` and `--tls-key` work too, but renewal and restart become your job.

The relay's port carries nothing but the WebSocket. `workerdeck relay status` reads a unix socket
in the state dir (`relay.sock`, mode 0600), so it works the same behind a proxy or under
`--tls-cert`, and only a user who can read the state dir can ask.

### Keys

`enroll` prints the key once. Send it straight to the gateway that needs it, without it landing
on a screen or in a chat:

```bash
workerdeck relay enroll laptop --state-dir /srv/relay | sed -n 's/^  //p' \
  | ssh laptop 'mkdir -p ~/.workerdeck && umask 077 && cat > ~/.workerdeck/relay.key'
```

A lost key is `enroll <name> --rotate`, never a second name: the name is the routing prefix.

### Verify

- On the relay's machine, `workerdeck relay status` (with the same `--state-dir` as `serve`) lists every enrolled gateway with
  `online` and a session count.
- In a session on one gateway, ask the agent to call `peers_list`: the other gateway's sessions
  appear as `gateway:session`. `peers_peek` one and `peers_send` it a line; the reply comes back
  the same way. A parked session on the other gateway peeks as `live: false` with no recent lines
  until something wakes it.

A gateway started with `--hot-reload` picks up a newly created config file with a `relay` block on
`workerdeck reload`, without dropping its sessions. Without `--hot-reload`, restart the gateway
when nothing is running.

Restarting the relay is harmless. Every gateway logs `connection lost (1001 relay shutting down);
reconnecting`, comes back within seconds and republishes its sessions; `KeepAlive` does the
restart for you.

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

# @workerdeck/relay

The WorkerDeck relay: one always-on process every gateway dials out to. It holds the cross-gateway
session registry, authenticates enrolled gateways, enforces the visibility rules, and routes peer
`peek` and `send` requests between gateways, so agents on separate machines can work together.

Part of [WorkerDeck](https://github.com/workerdeck/workerdeck). The `workerdeck` CLI runs it too, as
`workerdeck relay`.

## Install

```bash
npm install -g @workerdeck/relay
```

## Usage

```bash
workerdeck-relay enroll mac-mini        # prints the gateway key once
workerdeck-relay serve --host 0.0.0.0   # plain ws://, or add --tls-cert/--tls-key
workerdeck-relay status                 # who is online
workerdeck-relay revoke mac-mini
```

Rules live in `~/.workerdeck/relay/rules.json` and default to deny:

```json
{ "rules": [{ "from": "*", "to": "*" }] }
```

A rule without `allow` permits `send` and `peek`. See the
[cross-gateway peers guide](https://workerdeck.github.io/workerdeck/guides/cross-gateway-peers/).

Embed it with `startRelay({ stateDir, host, port, tls })`.

## License

MIT © Tobias Strebitzer - see
[LICENSE](https://github.com/workerdeck/workerdeck/blob/master/LICENSE).

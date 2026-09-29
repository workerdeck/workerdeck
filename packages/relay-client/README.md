# @workerdeck/relay-client

The gateway side of the WorkerDeck relay: the relay wire frames, `connectRelay` (dial out, auth,
heartbeat, reconnect with backoff), the diffing session-registry publisher, and the request
routing that lets agents on separate gateways list, peek at and message each other.

Part of [WorkerDeck](https://github.com/workerdeck/workerdeck). You rarely use it directly: set the
`relay` option on [`@workerdeck/server`](https://www.npmjs.com/package/@workerdeck/server) (or in
`workerdeck.config.mjs`) and the gateway connects on its own. The relay itself is
[`@workerdeck/relay`](https://www.npmjs.com/package/@workerdeck/relay).

## Install

```bash
npm install @workerdeck/relay-client
```

## Usage

```ts
import { connectRelay } from '@workerdeck/relay-client'

const relay = connectRelay(
  { url: 'ws://relay.local:7777', gateway: 'mac-mini', key: process.env.RELAY_KEY!, allow: ['send', 'peek'] },
  {
    snapshot: async () => sessions(), // every session this gateway publishes
    peek: async (origin, sessionId, recent) => peekLocal(sessionId, recent),
    send: async (origin, sessionId, text) => deliverLocal(origin, sessionId, text),
  },
)

const rows = await relay.list('my-session-id')
```

See the [cross-gateway peers guide](https://workerdeck.github.io/workerdeck/guides/cross-gateway-peers/).

## License

MIT © Tobias Strebitzer - see
[LICENSE](https://github.com/workerdeck/workerdeck/blob/master/LICENSE).

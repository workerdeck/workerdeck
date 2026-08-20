/**
 * A real APNs push, on demand, through the real payload builder.
 *
 *   pnpm smoke:push <host> [sessionId]
 *   pnpm smoke:push toby.example.ts.net:8788
 *   pnpm smoke:push 127.0.0.1:8787 a8cabb30-6ee9-449d-9819-8877b44a8416
 *
 * **This exists because push is the one surface that cannot be tested by
 * waiting.** Everything else on this gateway answers a request; a notification
 * only happens when a session decides to raise one, which makes "does a tap
 * open the right session" a thing you can only observe by accident — and so it
 * went unobserved. Tapping a notification aborted the iOS app on a main-thread
 * assert for two days and eight crash reports before anyone tapped one on
 * purpose (see `docs/GOTCHAS.md`, §APNs push).
 *
 * It goes through `buildPush`, not a hand-written `aps` dictionary, and that is
 * the whole point. A hand-rolled payload carries no `sessionId`, so
 * `PushPayload.init?` returns nil, so the tap routes nowhere — which reads
 * exactly like a broken deep link and is not one. If you are testing routing,
 * the payload has to be the one the forwarder actually sends.
 *
 * Reads the device registry the gateway itself writes, so it pushes to whatever
 * is really registered. Requires an `apns`-configured gateway (a gateway
 * without one answers `/apns/devices` with 404 and has no registry at all).
 */
import { readFile } from 'node:fs/promises'
import type { SessionInfo } from '@workerdeck/protocol'
import { createApnsClient, loadApnsKey } from '../packages/cli/src/apns/client.ts'
import { buildPush } from '../packages/cli/src/apns/forwarder.ts'

type Registry = {
  devices: {
    token: string
    environment: 'development' | 'production'
    hostId?: string
    bundleId?: string
  }[]
}

const [host, wantedSession] = process.argv.slice(2)
if (host === undefined) {
  console.error('usage: pnpm smoke:push <host> [sessionId]')
  process.exit(2)
}

// Everything below the gateway's own config: the registry path and the key are
// the operator's, and this script is deliberately not a second place that knows
// how to mint a credential.
const stateDir = process.env.WD_STATE_DIR ?? '/tmp/workerdeck-prod'
const keyFile = process.env.WD_APNS_KEY
const keyId = process.env.WD_APNS_KEY_ID
const teamId = process.env.WD_APNS_TEAM_ID
const topic = process.env.WD_APNS_TOPIC
if (keyFile === undefined || keyId === undefined || teamId === undefined || topic === undefined) {
  console.error(
    'set WD_APNS_KEY, WD_APNS_KEY_ID, WD_APNS_TEAM_ID and WD_APNS_TOPIC to the same values\n' +
      "as the gateway's `apns` config; WD_STATE_DIR defaults to /tmp/workerdeck-prod.",
  )
  process.exit(2)
}

const base = host.startsWith('http') ? host : `http://${host}`
const { sessions } = (await (await fetch(`${base}/v1/sessions`)).json()) as {
  sessions: SessionInfo[]
}
const session = wantedSession === undefined ? sessions[0] : sessions.find((s) => s.id === wantedSession)
if (session === undefined) {
  console.error(wantedSession === undefined ? 'no sessions on that gateway' : `no session ${wantedSession}`)
  process.exit(1)
}

const registry = JSON.parse(
  await readFile(`${stateDir}/apns-devices.json`, 'utf8'),
) as Registry
console.log(`session ${session.id} — ${registry.devices.length} device(s) registered`)

const key = await loadApnsKey(keyFile)
const client = createApnsClient({ keyFile, keyId, teamId, topic }, key)

for (const device of registry.devices) {
  const push = buildPush(
    {
      type: 'turn_completed',
      sessionId: session.id,
      session,
      seq: session.lastSeq,
      ts: Date.now(),
      preview: 'smoke:push — tapping this should open this session.',
      result: { isError: false, durationMs: 1, numTurns: 1, totalCostUsd: 0 },
    },
    device.hostId,
  )
  console.log(`payload ${JSON.stringify(push.payload)}`)
  const result = await client.send({
    ...push,
    deviceToken: device.token,
    environment: device.environment,
  })
  console.log(`  ${device.token.slice(0, 12)}… [${device.environment}] -> ${JSON.stringify(result)}`)
}
client.close()

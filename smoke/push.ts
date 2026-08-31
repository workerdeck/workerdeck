// pnpm smoke:push <host> [sessionId] [seq]     — a real push to whatever the gateway's own registry holds.
//
// Needs an `apns`-configured gateway: without one there is no `/apns/devices` route and no registry to read.
// `[seq]` is what makes the deep link testable — the default is the session's tail, where a client that lands on the
// right row is indistinguishable from one that ignores `seq` and scrolls to the bottom. `docs/GOTCHAS.md` §APNs push
// has the two ways this 401s.
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

const [host, wantedSession, wantedSeq] = process.argv.slice(2)
if (host === undefined) {
  console.error('usage: pnpm smoke:push <host> [sessionId] [seq]')
  process.exit(2)
}
if (wantedSeq !== undefined && !/^\d+$/.test(wantedSeq)) {
  console.error(`seq must be a positive integer, got ${wantedSeq}`)
  process.exit(2)
}

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
// The gateway's own operator secret, never a model credential. Absent is normal: a keyless gateway wants none.
const authKey = process.env.WD_AUTH_KEY
const listed = await fetch(`${base}/v1/sessions`, {
  headers: authKey === undefined ? {} : { authorization: `Bearer ${authKey}` },
})
if (!listed.ok) {
  console.error(
    `GET /v1/sessions -> ${listed.status}. ` +
      (listed.status === 401
        ? "Set WD_AUTH_KEY to the gateway's <state-dir>/auth-key — and check the host is spelled\n" +
          'the way the gateway was started: the Host-header guard also answers 401.'
        : ''),
  )
  process.exit(1)
}
const { sessions } = (await listed.json()) as {
  sessions: SessionInfo[]
}
const session = wantedSession === undefined ? sessions[0] : sessions.find((s) => s.id === wantedSession)
if (session === undefined) {
  console.error(wantedSession === undefined ? 'no sessions on that gateway' : `no session ${wantedSession}`)
  process.exit(1)
}

const registry = JSON.parse(await readFile(`${stateDir}/apns-devices.json`, 'utf8')) as Registry
const seq = wantedSeq === undefined ? session.lastSeq : Number(wantedSeq)
console.log(
  `session ${session.id} — seq ${seq}${seq === session.lastSeq ? ' (the tail)' : ` of ${session.lastSeq}`}` +
    ` — ${registry.devices.length} device(s) registered`,
)

const key = await loadApnsKey(keyFile)
const client = createApnsClient({ keyFile, keyId, teamId, topic }, key)

for (const device of registry.devices) {
  const push = buildPush(
    {
      type: 'turn_completed',
      sessionId: session.id,
      session,
      seq,
      ts: Date.now(),
      preview:
        wantedSeq === undefined
          ? 'smoke:push — tapping this should open this session.'
          : `smoke:push — tapping this should land on seq ${seq}, not at the bottom.`,
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

/**
 * A real APNs push, on demand, through the real payload builder.
 *
 *   pnpm smoke:push <host> [sessionId] [seq]
 *   pnpm smoke:push toby.example.ts.net:8788
 *   pnpm smoke:push 127.0.0.1:8787 a8cabb30-6ee9-449d-9819-8877b44a8416
 *   pnpm smoke:push toby.example.ts.net:8787 a8cabb30-… 1800   # land mid-transcript
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
 *
 * **`[seq]` is what makes the deep link testable.** Without it the push carries
 * the session's `lastSeq` — the tail — and a client that lands on the right row
 * is indistinguishable from one that ignores `seq` entirely and scrolls to the
 * bottom, which is exactly the bug the whole feature exists to fix. Pass a seq
 * from the *middle* of a long session and the answer is unambiguous: the reader
 * arrives with history above them, or the feature does not work.
 *
 * Two things that will 401 you against a real gateway, both learned here:
 * `WD_AUTH_KEY` (the gateway's own operator secret, `<state-dir>/auth-key`) is
 * needed the moment `--auth-key` is in play, and the host **must be spelled the
 * way the gateway was started** — the Host-header guard rejects the tailnet IP
 * of a gateway launched with `--host <name>`, and it answers `unauthorized`
 * rather than anything that mentions hosts.
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

const [host, wantedSession, wantedSeq] = process.argv.slice(2)
if (host === undefined) {
  console.error('usage: pnpm smoke:push <host> [sessionId] [seq]')
  process.exit(2)
}
if (wantedSeq !== undefined && !/^\d+$/.test(wantedSeq)) {
  console.error(`seq must be a positive integer, got ${wantedSeq}`)
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
// The gateway's own operator secret, never a model credential (root CLAUDE.md,
// auth red lines). Absent is normal — a gateway started without `--auth-key`
// wants no header at all.
const authKey = process.env.WD_AUTH_KEY
const listed = await fetch(`${base}/v1/sessions`, {
  headers: authKey === undefined ? {} : { authorization: `Bearer ${authKey}` },
})
if (!listed.ok) {
  console.error(
    `GET /v1/sessions -> ${listed.status}. ` +
      (listed.status === 401
        ? 'Set WD_AUTH_KEY to the gateway\'s <state-dir>/auth-key — and check the host is spelled\n' +
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

const registry = JSON.parse(
  await readFile(`${stateDir}/apns-devices.json`, 'utf8'),
) as Registry
// The tail unless told otherwise — see the `[seq]` note at the top of this file.
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

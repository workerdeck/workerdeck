// pnpm smoke:activity <host> start|update|end [sessionId]   - a real Live Activity push, no session needed.
//
// The device half of this cannot be tested any other way: push-to-start does not work in the
// Simulator, and the gateway's own driver only fires on a real turn. This drives the same builder
// the forwarder uses, against whatever tokens the gateway's registries actually hold.
//
// `start` reads `apns-devices.json` and pushes to every `liveActivityStartToken`; `update` and `end`
// read `apns-activities.json`, which only has entries once the phone has reported an update token
// back - so the order is always start, wait a beat, then update. Same env vars and the same two
// 401s as `smoke:push` (`docs/GOTCHAS.md` §APNs push).
import { readFile } from 'node:fs/promises'
import type { SessionInfo } from '@workerdeck/protocol'
import { createApnsClient, loadApnsKey } from '../packages/cli/src/apns/client.ts'
import { attributesFor, buildLiveActivityPush, projectContentState } from '../packages/cli/src/apns/live-activity.ts'
import type { ActivityRecord } from '../packages/cli/src/apns/activities.ts'
import type { DeviceRecord } from '../packages/cli/src/apns/devices.ts'

const [host, kindArg = 'start', wantedSession] = process.argv.slice(2)
if (host === undefined || !['start', 'update', 'end'].includes(kindArg)) {
  console.error('usage: pnpm smoke:activity <host> start|update|end [sessionId]')
  process.exit(2)
}
const kind = kindArg as 'start' | 'update' | 'end'

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
const authKey = process.env.WD_AUTH_KEY
const listed = await fetch(`${base}/v1/sessions`, {
  headers: authKey === undefined ? {} : { authorization: `Bearer ${authKey}` },
})
if (!listed.ok) {
  console.error(
    `GET /v1/sessions -> ${listed.status}. ` +
      (listed.status === 401 ? "Set WD_AUTH_KEY to the gateway's <state-dir>/auth-key, and check the host spelling." : ''),
  )
  process.exit(1)
}
const { sessions } = (await listed.json()) as { sessions: SessionInfo[] }
const session = wantedSession === undefined ? sessions[0] : sessions.find((one) => one.id === wantedSession)
if (session === undefined) {
  console.error(wantedSession === undefined ? 'no sessions on that gateway' : `no session ${wantedSession}`)
  process.exit(1)
}

const key = await loadApnsKey(keyFile)
const client = createApnsClient({ keyFile, keyId, teamId, topic }, key)
const state = projectContentState({
  info: session,
  startedAtMs: Date.now() - 90_000,
  ...(kind === 'end' ? { finalPhase: 'done' as const, finalHeadline: 'smoke:activity - ended' } : {}),
})

if (kind === 'start') {
  const { devices } = JSON.parse(await readFile(`${stateDir}/apns-devices.json`, 'utf8')) as { devices: DeviceRecord[] }
  const startable = devices.filter((device) => device.liveActivityStartToken !== undefined)
  console.log(`session ${session.id} - ${startable.length} of ${devices.length} device(s) can be started at`)
  if (startable.length === 0) {
    console.error('no device has a push-to-start token: open the app once on a build that registers one.')
    process.exit(1)
  }
  for (const device of startable) {
    const push = buildLiveActivityPush('start', { attributes: attributesFor(session, device.hostId), state })
    const result = await client.send({
      ...push,
      deviceToken: device.liveActivityStartToken!,
      environment: device.environment,
    })
    console.log(`  start ${device.liveActivityStartToken!.slice(0, 12)}… [${device.environment}] -> ${JSON.stringify(result)}`)
  }
} else {
  const { activities } = JSON.parse(await readFile(`${stateDir}/apns-activities.json`, 'utf8')) as { activities: ActivityRecord[] }
  const live = activities.filter((record) => record.sessionId === session.id && record.updateToken !== undefined)
  console.log(`session ${session.id} - ${live.length} live card(s)`)
  if (live.length === 0) {
    console.error('no card has reported an update token yet: run `start` first and give the phone a moment.')
    process.exit(1)
  }
  for (const record of live) {
    const push = buildLiveActivityPush(kind, {
      attributes: { sessionId: record.sessionId, hostId: record.hostId, cwdLeaf: '' },
      state,
      urgent: true,
    })
    const result = await client.send({ ...push, deviceToken: record.updateToken!, environment: record.environment })
    console.log(`  ${kind} ${record.updateToken!.slice(0, 12)}… [${record.environment}] -> ${JSON.stringify(result)}`)
  }
}
client.close()

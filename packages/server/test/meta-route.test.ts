import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type GatewayMeta } from '@workerdeck/protocol'
import { machineId } from '../src/lib/machine-id.ts'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

let running: WorkerServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

const PRINCIPALS: Record<string, unknown> = {
  operator: {},
  viewer: { scope: { space: 'a' } },
}

async function start(scoped: boolean): Promise<string> {
  running = scoped
    ? createWorkerServer({
        authenticate: (req) => PRINCIPALS[(req.headers.authorization ?? '').replace(/^Bearer /, '')] ?? null,
      })
    : createWorkerServer({ allowUnauthenticated: true })
  const { port } = await running.listen(0, '127.0.0.1')
  return `http://127.0.0.1:${port}/v1`
}

describe('gateway meta', () => {
  it('reports the protocol version and this machine to an operator', async () => {
    const res = await fetch(`${await start(false)}/meta`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      machineId: machineId(),
      agents: { sharing: 'private', allowShared: true },
    })
  })

  it('tells an operator what a new agent defaults to, and that a gateway sharing nothing defaults to private', async () => {
    running = createWorkerServer({ allowUnauthenticated: true, owner: 'tobias', agentSharing: { default: 'shared' } })
    const { port } = await running.listen(0, '127.0.0.1')
    const shared = (await (await fetch(`http://127.0.0.1:${port}/v1/meta`)).json()) as GatewayMeta
    expect(shared.agents).toEqual({ owner: 'tobias', sharing: 'shared', allowShared: true })
    await running.close()

    running = createWorkerServer({ allowUnauthenticated: true, agentSharing: { default: 'shared', allowShared: false } })
    const closed = await running.listen(0, '127.0.0.1')
    const refused = (await (await fetch(`http://127.0.0.1:${closed.port}/v1/meta`)).json()) as GatewayMeta
    expect(refused.agents).toEqual({ sharing: 'private', allowShared: false })
  })

  it('withholds the fingerprint from a scoped principal and the whole route from an anonymous one', async () => {
    const base = await start(true)
    expect((await fetch(`${base}/meta`)).status).toBe(401)

    const scoped = await fetch(`${base}/meta`, { headers: { authorization: 'Bearer viewer' } })
    expect(scoped.status).toBe(200)
    expect(await scoped.json()).toEqual({ protocolVersion: PROTOCOL_VERSION })

    const operator = await fetch(`${base}/meta`, { headers: { authorization: 'Bearer operator' } })
    expect(await operator.json()).toMatchObject({ machineId: machineId() })
  })
})

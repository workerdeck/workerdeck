import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionInfo } from '@workerdeck/protocol'
import { createFileSessionRecordStore, createWorkerServer } from '../src/index.ts'
import WebSocket from 'ws'
import { fakeHarness, frameCollector, gatewayFixture, listenOn, until } from './helpers.ts'

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-1',
  model: 'claude-test-1',
  cwd: '/tmp',
  tools: [],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  plugins: [],
  uuid: 'uuid-init',
} as unknown as SDKMessage

const { servers, stateDir, cleanup } = gatewayFixture('wd-status-label-')
afterEach(cleanup)

async function startGateway(dir: string) {
  const harness = fakeHarness()
  const server = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    sessions: { store: createFileSessionRecordStore({ dir }) },
    parking: { parkDelayMs: 10 },
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
  })
  servers.push(server)
  const { base, wsBase } = await listenOn(server)
  return { server, harness, base, wsBase }
}

async function call<T>(base: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method, headers: { 'x-workerdeck-generation': '1' } }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json', 'x-workerdeck-generation': '1' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, init)
  return { status: res.status, body: (await res.json()) as T }
}

describe('status label', () => {
  it('is set and cleared over PATCH, refused when malformed, and survives a gateway restart as a dormant record', async () => {
    const dir = await stateDir()
    const first = await startGateway(dir)
    const created = await call<{ session: SessionInfo }>(first.base, '/sessions', 'POST', { cwd: '/tmp' })
    const id = created.body.session.id
    first.harness.emit(initMessage)
    await until(async () => (await call<{ session: SessionInfo }>(first.base, `/sessions/${id}`)).body.session.sdkSessionId === 'sdk-1', 'the engine to name its session')

    const set = await call<{ session: SessionInfo }>(first.base, `/sessions/${id}`, 'PATCH', {
      statusLabel: { text: ' waiting on CI ', emoji: '⏳', waitingOn: 'human' },
    })
    expect(set.status).toBe(200)
    expect(set.body.session.statusLabel).toMatchObject({ text: 'waiting on CI', emoji: '⏳', waitingOn: 'human' })
    expect((await call(first.base, `/sessions/${id}`, 'PATCH', { statusLabel: { text: 'x'.repeat(81) } })).status).toBe(400)
    expect((await call(first.base, `/sessions/${id}`, 'PATCH', { statusLabel: { text: 'x', waitingOn: 'lead' } })).status).toBe(400)

    await until(async () => (await readFile(join(dir, `${id}.json`), 'utf8').catch(() => '')).includes('waiting on CI'), 'the label to reach the record file')
    await first.server.close()
    const second = await startGateway(dir)
    const listed = await call<{ sessions: SessionInfo[] }>(second.base, '/sessions')
    expect(listed.body.sessions.find((s) => s.id === id)?.statusLabel).toMatchObject({ text: 'waiting on CI', waitingOn: 'human' })

    const cleared = await call<{ session: SessionInfo }>(second.base, `/sessions/${id}`, 'PATCH', { statusLabel: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.session.statusLabel).toBeUndefined()
  })
  it('drops waitingOn when a person sends a message, keeping the text and emoji', async () => {
    const gateway = await startGateway(await stateDir())
    const created = await call<{ session: SessionInfo }>(gateway.base, '/sessions', 'POST', { cwd: '/tmp' })
    const id = created.body.session.id
    gateway.harness.emit(initMessage)
    await until(async () => (await call<{ session: SessionInfo }>(gateway.base, `/sessions/${id}`)).body.session.sdkSessionId === 'sdk-1', 'the engine to name its session')
    await call(gateway.base, `/sessions/${id}`, 'PATCH', { statusLabel: { text: 'awaiting commit go', emoji: '✅', waitingOn: 'human' } })

    const ws = new WebSocket(`${gateway.wsBase}/sessions/${id}/ws`)
    const collector = frameCollector(ws)
    await collector.waitFor((f) => f.type === 'attached')
    ws.send(JSON.stringify({ generation: 1, type: 'user_message', text: 'go ahead', clientId: 'c.1' }))
    await collector.waitFor((f) => f.type === 'ack' && f.clientId === 'c.1')
    ws.close()

    const label = (await call<{ session: SessionInfo }>(gateway.base, `/sessions/${id}`)).body.session.statusLabel
    expect(label).toMatchObject({ text: 'awaiting commit go', emoji: '✅' })
    expect(label?.waitingOn).toBeUndefined()
  })
})

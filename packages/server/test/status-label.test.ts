import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionInfo } from '@workerdeck/protocol'
import { createFileSessionStore, createWorkerServer } from '../src/index.ts'
import { fakeHarness, gatewayFixture, listenOn } from './helpers.ts'

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
    parking: { store: createFileSessionStore({ dir }), parkDelayMs: 10 },
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
  })
  servers.push(server)
  const { base } = await listenOn(server)
  return { server, harness, base }
}

async function call<T>(base: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, init)
  return { status: res.status, body: (await res.json()) as T }
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250 && !(await check()); i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('status label', () => {
  it('is set and cleared over PATCH, refused when malformed, and survives a gateway restart as a dormant record', async () => {
    const dir = await stateDir()
    const first = await startGateway(dir)
    const created = await call<{ session: SessionInfo }>(first.base, '/sessions', 'POST', { cwd: '/tmp' })
    const id = created.body.session.id
    first.harness.emit(initMessage)
    await until(async () => (await call<{ session: SessionInfo }>(first.base, `/sessions/${id}`)).body.session.sdkSessionId === 'sdk-1')

    const set = await call<{ session: SessionInfo }>(first.base, `/sessions/${id}`, 'PATCH', {
      statusLabel: { text: ' waiting on CI ', emoji: '⏳' },
    })
    expect(set.status).toBe(200)
    expect(set.body.session.statusLabel).toMatchObject({ text: 'waiting on CI', emoji: '⏳' })
    expect((await call(first.base, `/sessions/${id}`, 'PATCH', { statusLabel: { text: 'x'.repeat(81) } })).status).toBe(400)

    await until(async () => (await readFile(join(dir, `${id}.json`), 'utf8')).includes('waiting on CI'))
    await first.server.close()
    const second = await startGateway(dir)
    const listed = await call<{ sessions: SessionInfo[] }>(second.base, '/sessions')
    expect(listed.body.sessions.find((s) => s.id === id)?.statusLabel).toMatchObject({ text: 'waiting on CI' })

    const cleared = await call<{ session: SessionInfo }>(second.base, `/sessions/${id}`, 'PATCH', { statusLabel: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.session.statusLabel).toBeUndefined()
  })
})

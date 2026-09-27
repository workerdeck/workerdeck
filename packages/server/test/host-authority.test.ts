import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, sandboxedProviderProfile, type EngineRunnerContext, type WorkerServer } from '../src/index.ts'
import { fakeRunner, idleQuery } from './helpers.ts'

let running: WorkerServer | undefined
const tempDirs: string[] = []
afterEach(async () => {
  await running?.close()
  running = undefined
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const PRINCIPALS: Record<string, unknown> = {
  operator: {},
  guest: { scope: { user: 'guest' } },
  trusted: { scope: { user: 'trusted' }, allowedProfiles: ['host', 'sandboxed'] },
}

async function startServer(): Promise<string> {
  let n = 0
  const configDir = mkdtempSync(join(tmpdir(), 'wd-authority-claude-'))
  tempDirs.push(configDir)
  running = createWorkerServer({
    authenticate: (req) => PRINCIPALS[(req.headers.authorization ?? '').replace(/^Bearer /, '')] ?? null,
    profiles: [sandboxedProviderProfile('sandboxed', { id: 'openai-compatible', model: 'test-model' }), { name: 'host', configDir }],
    buildRunnerConfig: (req) => ({ ...req, queryFn: idleQuery }),
    createEngineRunner: (ctx: EngineRunnerContext) => fakeRunner(`s${++n}`, ctx.config),
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return `http://127.0.0.1:${port}/v1`
}

function cwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wd-authority-'))
  tempDirs.push(dir)
  return dir
}

async function create(
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; error?: string; session?: SessionInfo }> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, ...((await res.json()) as { error?: string; session?: SessionInfo }) }
}

describe('host authority on a non-operator create', () => {
  it('refuses a host-engine profile the principal was not explicitly given', async () => {
    const base = await startServer()
    expect((await create(base, 'guest', { profile: 'host', cwd: cwd() })).status).toBe(403)
    expect((await create(base, 'guest', { profile: 'sandboxed' })).status).toBe(201)
    expect((await create(base, 'trusted', { profile: 'host', cwd: cwd() })).status).toBe(201)
  })

  it.each([
    ['bypassPermissions', { permissionMode: 'bypassPermissions' }],
    ['dontAsk', { permissionMode: 'dontAsk' }],
    ['allowDangerouslySkipPermissions', { allowDangerouslySkipPermissions: true }],
    ['settingSources', { settingSources: ['project'] }],
    ['a stdio MCP server', { mcpServers: { local: { command: '/bin/sh', args: ['-c', 'id'] } } }],
    ['resume of a session it cannot see', { resume: 'someone-elses-sdk-session' }],
  ])('refuses %s even on a profile it was given, and leaves the operator alone', async (_label, fields) => {
    const base = await startServer()
    const refused = await create(base, 'trusted', { profile: 'host', cwd: cwd(), ...fields })
    expect(refused.status).toBe(403)
    expect(refused.error).toMatch(/operators|can see/)
    if (!('resume' in fields)) {
      expect((await create(base, 'operator', { profile: 'host', cwd: cwd(), ...fields })).status).toBe(201)
    }
  })

  it('still takes an http MCP server from a principal given a host profile', async () => {
    const base = await startServer()
    const res = await create(base, 'trusted', {
      profile: 'host',
      cwd: cwd(),
      mcpServers: { docs: { type: 'http', url: 'https://mcp.example/' } },
    })
    expect(res.status).toBe(201)
  })
})

describe('set_permission_mode from a non-operator', () => {
  it('refuses the modes a create would have refused', async () => {
    const base = await startServer()
    const { session } = await create(base, 'trusted', { profile: 'host', cwd: cwd() })
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/sessions/${session!.id}/ws`, { headers: { authorization: 'Bearer trusted' } })
    const errors: string[] = []
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as { type: string; message?: string }
      if (frame.type === 'protocol_error') {
        errors.push(frame.message ?? '')
      }
    })
    await new Promise((resolve) => ws.once('open', resolve))
    ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'bypassPermissions' }))
    ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'dontAsk' }))
    await expect.poll(() => errors).toHaveLength(2)
    expect(errors.every((message) => /reserved to operators/.test(message))).toBe(true)
    ws.close()
  })
})

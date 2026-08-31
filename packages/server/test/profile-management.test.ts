import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProfileInfo } from '@workerdeck/protocol'
import { createFileProfileStore, createMemoryProfileStore, createWorkerServer, type WorkerServer } from '../src/index.ts'
import { fakeRunner } from './helpers.ts'

let running: WorkerServer | undefined
let tempDir: string | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
  }
  tempDir = undefined
})

function temp(): string {
  return (tempDir ??= mkdtempSync(join(tmpdir(), 'cw-profiles-')))
}

function kimi(): ProfileInfo {
  return {
    name: 'kimi',
    engine: 'provider',
    provider: { id: 'moonshotai', model: 'kimi-k3', apiKeyEnv: 'MOONSHOT_API_KEY' },
  }
}

// The principal manages profiles unless the request sends `x-readonly: 1`.
function manageableServer(options: Parameters<typeof createWorkerServer>[0] = {}) {
  return createWorkerServer({
    authenticate: (req) => ({ canManageProfiles: req.headers['x-readonly'] !== '1' }),
    allowedCwdRoots: ['/tmp'],
    profileStore: createMemoryProfileStore(),
    createEngineRunner: ({ config }) => fakeRunner('engine-1', config),
    profiles: [],
    ...options,
  })
}

function post(port: number, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('profile management', () => {
  it('creates a managed profile that sessions can immediately run under', async () => {
    running = manageableServer()
    const { port } = await running.listen(0, '127.0.0.1')

    const created = await post(port, kimi())
    expect(created.status).toBe(200)
    expect(((await created.json()) as { profile: ProfileInfo }).profile.name).toBe('kimi')

    const listed = (await fetch(`http://127.0.0.1:${port}/v1/profiles`).then((r) => r.json())) as {
      profiles: ProfileInfo[]
    }
    expect(listed.profiles.map((p) => p.name)).toEqual(['kimi'])
    const session = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    expect(session.status).toBe(201)
  })

  it('patches a managed profile without renaming it', async () => {
    running = manageableServer()
    const { port } = await running.listen(0, '127.0.0.1')
    await post(port, kimi())

    const res = await fetch(`http://127.0.0.1:${port}/v1/profiles/kimi`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed', description: 'now with a description' }),
    })
    expect(res.status).toBe(200)
    const { profile } = (await res.json()) as { profile: ProfileInfo }
    expect(profile.name).toBe('kimi')
    expect(profile.description).toBe('now with a description')
    expect(profile.provider?.model).toBe('kimi-k3')
  })

  it('deletes a managed profile', async () => {
    running = manageableServer()
    const { port } = await running.listen(0, '127.0.0.1')
    await post(port, kimi())

    const res = await fetch(`http://127.0.0.1:${port}/v1/profiles/kimi`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    const listed = (await fetch(`http://127.0.0.1:${port}/v1/profiles`).then((r) => r.json())) as {
      profiles: ProfileInfo[]
    }
    expect(listed.profiles).toEqual([])
  })

  it('refuses management without the principal flag', async () => {
    running = manageableServer()
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await post(port, kimi(), { 'x-readonly': '1' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/not allowed to manage/)
  })

  it('refuses management with no store, however the principal is marked', async () => {
    running = createWorkerServer({
      authenticate: () => ({ canManageProfiles: true }),
      profiles: [],
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await post(port, kimi())
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toMatch(/not enabled/)
  })

  it('refuses to edit or delete a startup-declared profile', async () => {
    const configDir = temp()
    running = manageableServer({ profiles: [{ name: 'declared', configDir }] })
    const { port } = await running.listen(0, '127.0.0.1')

    for (const method of ['PATCH', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/profiles/declared`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'PATCH' ? JSON.stringify({ description: 'x' }) : undefined,
      })
      expect(res.status, method).toBe(403)
      expect(((await res.json()) as { error: string }).error).toMatch(/declared in server options/)
    }
  })

  it('refuses a name a declared profile already holds', async () => {
    const configDir = temp()
    running = manageableServer({ profiles: [{ name: 'declared', configDir }] })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await post(port, { name: 'declared', engine: 'provider', provider: { id: 'x' } })
    expect(res.status).toBe(409)
  })

  it('applies the same validation a startup profile gets', async () => {
    running = manageableServer()
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await post(port, { name: 'broken', engine: 'provider' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/missing provider\.id/)
  })

  it('refuses a managed claude profile unless config-dir roots are declared', async () => {
    running = manageableServer()
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await post(port, { name: 'mine', configDir: temp() })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/allowedConfigDirRoots/)
  })

  it('bounds a managed claude profile to the declared config-dir roots', async () => {
    const root = temp()
    running = manageableServer({ allowedConfigDirRoots: [root] })
    const { port } = await running.listen(0, '127.0.0.1')

    const outside = await post(port, { name: 'outside', configDir: homedirLike() })
    expect(outside.status).toBe(403)
    expect(((await outside.json()) as { error: string }).error).toMatch(/outside the allowed roots/)

    const inside = await post(port, { name: 'inside', configDir: root })
    expect(inside.status).toBe(200)
  })

  it('cannot widen a session past what the profile grants, however the profile got there', async () => {
    running = manageableServer()
    const { port } = await running.listen(0, '127.0.0.1')
    await post(port, { ...kimi(), session: { capabilities: ['web_fetch'] } })

    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/project',
        profile: 'kimi',
        capabilities: ['web_fetch', 'deliver_file'],
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/does not grant: deliver_file/)
  })
})

describe('createFileProfileStore', () => {
  it('round-trips through the file and survives a fresh server', async () => {
    const path = join(temp(), 'profiles.json')
    running = manageableServer({ profileStore: createFileProfileStore(path) })
    const { port } = await running.listen(0, '127.0.0.1')
    await post(port, kimi())
    await running.close()

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject([{ name: 'kimi' }])
    running = manageableServer({ profileStore: createFileProfileStore(path) })
    const restarted = await running.listen(0, '127.0.0.1')
    const listed = (await fetch(`http://127.0.0.1:${restarted.port}/v1/profiles`).then((r) => r.json())) as { profiles: ProfileInfo[] }
    expect(listed.profiles.map((p) => p.name)).toEqual(['kimi'])
  })

  it('starts empty on a corrupt file rather than refusing to boot', () => {
    const path = join(temp(), 'profiles.json')
    writeFileSync(path, '{ not json')
    const store = createFileProfileStore(path)
    expect(store.list()).toEqual([])
    store.save(kimi())
    expect((store.list() as ProfileInfo[]).map((p) => p.name)).toEqual(['kimi'])
  })
})

// A path that is definitely outside a fresh temp dir.
function homedirLike(): string {
  return join(tmpdir(), 'cw-definitely-elsewhere')
}

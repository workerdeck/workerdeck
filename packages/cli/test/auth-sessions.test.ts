import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthSessionStore } from '../src/auth/auth-sessions.ts'
import { createCliAuth } from '../src/auth/auth.ts'

const SECRET = 'correct-horse-battery-staple'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wd-auth-sessions-'))
  dirs.push(dir)
  return dir
}

const file = (dir: string): string => join(dir, 'auth-sessions.json')

describe('createAuthSessionStore', () => {
  it('starts empty, then round-trips rows through the file', async () => {
    const dir = await stateDir()
    const store = await createAuthSessionStore({ stateDir: dir })
    expect([...(store.initial ?? [])]).toEqual([])

    const expiresAt = Date.now() + 60_000
    store.save([['abc', { expiresAt }]])
    await store.flush?.()

    const reopened = await createAuthSessionStore({ stateDir: dir })
    expect([...(reopened.initial ?? [])]).toEqual([['abc', { expiresAt }]])
  })

  it('writes the file 0600', async () => {
    const dir = await stateDir()
    const store = await createAuthSessionStore({ stateDir: dir })
    store.save([['abc', { expiresAt: Date.now() + 60_000 }]])
    await store.flush?.()
    const { mode } = await stat(file(dir))
    expect(mode & 0o777).toBe(0o600)
  })

  it('drops expired rows on load rather than carrying them', async () => {
    const dir = await stateDir()
    const store = await createAuthSessionStore({ stateDir: dir })
    store.save([
      ['stale', { expiresAt: Date.now() - 1 }],
      ['live', { expiresAt: Date.now() + 60_000 }],
    ])
    await store.flush?.()
    const reopened = await createAuthSessionStore({ stateDir: dir })
    expect([...(reopened.initial ?? [])].map(([key]) => key)).toEqual(['live'])
  })

  it('treats corrupt, truncated and wrong-version files as empty', async () => {
    for (const body of ['', 'not json', '{"version":99,"sessions":[["a",1]]}', '{"version":1}']) {
      const dir = await stateDir()
      await writeFile(file(dir), body, { mode: 0o600 })
      const store = await createAuthSessionStore({ stateDir: dir })
      expect([...(store.initial ?? [])]).toEqual([])
    }
  })

  it('skips malformed rows but keeps the good ones', async () => {
    const dir = await stateDir()
    const expiresAt = Date.now() + 60_000
    await writeFile(
      file(dir),
      JSON.stringify({ version: 1, sessions: [['', 1e15], ['ok', expiresAt], ['bad', 'soon'], ['short'], 7] }),
      { mode: 0o600 },
    )
    const store = await createAuthSessionStore({ stateDir: dir })
    expect([...(store.initial ?? [])]).toEqual([['ok', { expiresAt }]])
  })

  it('warns once — not per write — when the directory cannot be written', async () => {
    const dir = await stateDir()
    const warnings: string[] = []
    // A file where the state dir should be: mkdir/writeFile both fail.
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'not a directory')
    const store = await createAuthSessionStore({ stateDir: blocked, warn: (m) => warnings.push(m) })
    store.save([['a', { expiresAt: Date.now() + 60_000 }]])
    store.save([['b', { expiresAt: Date.now() + 60_000 }]])
    await store.flush?.()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/could not persist browser logins/)
  })

  it('warns about a world-readable file but still uses it', async () => {
    const dir = await stateDir()
    const expiresAt = Date.now() + 60_000
    await writeFile(file(dir), JSON.stringify({ version: 1, sessions: [['a', expiresAt]] }), { mode: 0o644 })
    const warnings: string[] = []
    const store = await createAuthSessionStore({ stateDir: dir, warn: (m) => warnings.push(m) })
    expect([...(store.initial ?? [])]).toEqual([['a', { expiresAt }]])
    expect(warnings[0]).toMatch(/readable by other users/)
  })

  it('persists a real login end to end, and nothing secret lands on disk', async () => {
    const dir = await stateDir()
    const store = await createAuthSessionStore({ stateDir: dir })
    const auth = createCliAuth({ secret: SECRET, sessions: store })

    // Drive the login through the same path the dashboard does.
    const req = {
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event: string, handler: (chunk?: Buffer) => void) {
        if (event === 'data') handler(Buffer.from(JSON.stringify({ secret: SECRET })))
        if (event === 'end') handler()
        return this
      },
    } as never
    let cookie = ''
    const res = {
      headersSent: false,
      writeHead(_status: number, headers: Record<string, string>) {
        cookie = String(headers['set-cookie'] ?? '').split(';')[0]
        return this
      },
      end() {},
      once() {
        return this
      },
    } as never
    await auth.handleAuthRequest(req, res)
    await store.flush?.()

    const raw = await readFile(file(dir), 'utf8')
    const token = cookie.split('=')[1]
    expect(token.length).toBeGreaterThan(20)
    expect(raw).not.toContain(token)
    expect(raw).not.toContain(SECRET)

    const restarted = createCliAuth({ secret: SECRET, sessions: await createAuthSessionStore({ stateDir: dir }) })
    expect(restarted.hasValidSession({ headers: { cookie } } as never)).toBe(true)
  })
})

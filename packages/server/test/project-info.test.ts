import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectInfo, SessionInfo } from '@workerdeck/protocol'
import { ProjectInfoService } from '../src/services/project-info.ts'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

// A query that emits nothing and unblocks its consumer on close: these sessions never speak.
function queryFn(params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  void (async () => {
    for await (const _ of params.prompt) {
    }
  })()
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      if (done) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    close: () => {
      done = true
      waiter?.({ value: undefined, done: true })
    },
  } as unknown as Query
}

let running: WorkerServer | undefined
const tempDirs: string[] = []
afterEach(async () => {
  await running?.close()
  running = undefined
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wd-project-'))
  tempDirs.push(dir)
  return dir
}

async function startServer(root: string, extra: Parameters<typeof createWorkerServer>[0] = {}): Promise<string> {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: [root],
    buildRunnerConfig: (req) => ({ ...req, queryFn }),
    ...extra,
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return `http://127.0.0.1:${port}/v1`
}

async function createSession(base: string, cwd: string, headers: Record<string, string> = {}): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ cwd }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { session: SessionInfo }).session
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Anything at all passes as a PNG here: the gateway types by declared extension and never sniffs.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a-not-a-real-png', 'utf8')

describe('project discovery', () => {
  it('walks ancestors from the cwd, nearest .workerdeck.json wins, and the root is canonical', async () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const cwd = join(repo, 'packages', 'ui')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ name: 'WorkerDeck' }))

    const base = await startServer(root)
    const session = await createSession(base, cwd)
    expect(session.project).toEqual({ name: 'WorkerDeck', root: realpathSync(repo) })

    const list = (await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionInfo[] }
    expect(list.sessions[0]?.project?.name).toBe('WorkerDeck')

    // A fresh cwd on purpose: the resolver caches per cwd for its TTL, so reusing one would serve the cached answer.
    writeFileSync(join(repo, 'packages', '.workerdeck.json'), JSON.stringify({ name: 'UI Kit' }))
    const cwd2 = join(repo, 'packages', 'react')
    mkdirSync(cwd2, { recursive: true })
    const nearer = await createSession(base, cwd2)
    expect(nearer.project).toEqual({ name: 'UI Kit', root: realpathSync(join(repo, 'packages')) })
  })

  it('degrades to no project at all when nothing is declared — todays wire, byte for byte', async () => {
    const root = tempRoot()
    const cwd = join(root, 'plain')
    mkdirSync(cwd, { recursive: true })
    const base = await startServer(root)
    const session = await createSession(base, cwd)
    expect('project' in session).toBe(false)
  })

  it('skips a malformed, oversized or symlinked file and keeps walking to a valid ancestor', async () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const broken = join(repo, 'broken')
    const huge = join(repo, 'huge')
    const linked = join(repo, 'linked')
    mkdirSync(broken, { recursive: true })
    mkdirSync(huge, { recursive: true })
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ name: 'Valid' }))
    writeFileSync(join(broken, '.workerdeck.json'), '{ not json')
    writeFileSync(join(huge, '.workerdeck.json'), `{"name":"${'x'.repeat(70_000)}"}`)
    writeFileSync(join(repo, 'elsewhere.json'), JSON.stringify({ name: 'Elsewhere' }))
    symlinkSync(join(repo, 'elsewhere.json'), join(linked, '.workerdeck.json'))

    const base = await startServer(root)
    for (const cwd of [broken, huge, linked]) {
      const session = await createSession(base, cwd)
      expect(session.project?.name).toBe('Valid')
      expect(session.project?.root).toBe(realpathSync(repo))
    }
  })

  it('treats {} as a project marker named by its basename, and degrades junk fields one by one', async () => {
    const root = tempRoot()
    const bare = join(root, 'bare-repo')
    const junk = join(root, 'junk-repo')
    mkdirSync(bare, { recursive: true })
    mkdirSync(junk, { recursive: true })
    writeFileSync(join(bare, '.workerdeck.json'), '{}')
    writeFileSync(join(junk, '.workerdeck.json'), JSON.stringify({ name: 42, icon: 'Not A Glyph!', unknownKey: true }))

    const base = await startServer(root)
    const bareSession = await createSession(base, bare)
    expect(bareSession.project).toEqual({ name: 'bare-repo', root: realpathSync(bare) })
    const junkSession = await createSession(base, junk)
    expect(junkSession.project).toEqual({ name: 'junk-repo', root: realpathSync(junk) })
  })

  it('ships a well-formed lucide name as a glyph, with no icon route behind it', async () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ name: 'Deck', icon: 'layers-3' }))
    const base = await startServer(root)
    const session = await createSession(base, repo)
    expect(session.project?.icon).toEqual({ type: 'glyph', name: 'layers-3' })
    const res = await fetch(`${base}/sessions/${session.id}/project/icon`)
    expect(res.status).toBe(404)
  })
})

describe('project icon route', () => {
  it('serves a contained png with the wire hash as its ETag, and 304s a revalidation', async () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'assets'), { recursive: true })
    writeFileSync(join(repo, 'assets', 'icon.png'), PNG_BYTES)
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ name: 'Deck', icon: './assets/icon.png' }))

    const base = await startServer(root)
    const session = await createSession(base, repo)
    const icon = session.project?.icon
    expect(icon).toEqual({ type: 'image', mediaType: 'image/png', hash: sha256(PNG_BYTES) })

    const res = await fetch(`${base}/sessions/${session.id}/project/icon`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('etag')).toBe(`"${sha256(PNG_BYTES)}"`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    const revalidated = await fetch(`${base}/sessions/${session.id}/project/icon`, {
      headers: { 'if-none-match': `"${sha256(PNG_BYTES)}"` },
    })
    expect(revalidated.status).toBe(304)
  })

  it('types an svg by its declared extension', async () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ icon: 'logo.svg' }))

    const base = await startServer(root)
    const session = await createSession(base, repo)
    expect(session.project?.icon).toMatchObject({ type: 'image', mediaType: 'image/svg+xml' })
    const res = await fetch(`${base}/sessions/${session.id}/project/icon`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
  })

  it('refuses a `..` escape, an absolute path, and a planted symlink — identically to no icon', async () => {
    const root = tempRoot()
    // The "secret" sits outside every project root but inside the cwd allowlist, so only icon containment stands in the way.
    const secret = join(root, 'secret.png')
    writeFileSync(secret, 'not for serving')

    const base = await startServer(root)
    const cases: Array<[string, string]> = [
      ['dotdot', '../secret.png'],
      ['absolute', secret],
      ['symlink', './planted.png'],
    ]
    for (const [dir, declared] of cases) {
      const repo = join(root, dir)
      mkdirSync(repo, { recursive: true })
      if (declared === './planted.png') {
        symlinkSync(secret, join(repo, 'planted.png'))
      }
      writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ name: 'Deck', icon: declared }))
      const session = await createSession(base, repo)
      expect(session.project).toEqual({ name: 'Deck', root: realpathSync(repo) })
      const res = await fetch(`${base}/sessions/${session.id}/project/icon`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'no project icon' })
    }
  })

  it('refuses an oversized icon and a wrong-extension one', async () => {
    const root = tempRoot()
    const repo = join(root, 'big')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'big.png'), Buffer.alloc(512 * 1024 + 1))
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ icon: './big.png' }))
    const base = await startServer(root)
    const big = await createSession(base, repo)
    expect(big.project?.icon).toBeUndefined()

    const wrong = join(root, 'wrong')
    mkdirSync(wrong, { recursive: true })
    writeFileSync(join(wrong, 'icon.jpeg'), PNG_BYTES)
    writeFileSync(join(wrong, '.workerdeck.json'), JSON.stringify({ icon: './icon.jpeg' }))
    const jpeg = await createSession(base, wrong)
    expect(jpeg.project?.icon).toBeUndefined()
  })

  it('404s another scope byte-identically to an unknown session', async () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'icon.png'), PNG_BYTES)
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ icon: './icon.png' }))

    const principals: Record<string, unknown> = {
      alice: { scope: { user: 'alice' } },
      carol: { scope: { user: 'carol' } },
    }
    const base = await startServer(root, {
      allowUnauthenticated: undefined,
      authenticate: (req) => principals[(req.headers.authorization ?? '').replace(/^Bearer /, '')] ?? null,
    })
    const session = await createSession(base, repo, { authorization: 'Bearer alice' })

    const unknown = await fetch(`${base}/sessions/nope/project/icon`, {
      headers: { authorization: 'Bearer carol' },
    })
    const expected = await unknown.text()
    expect(unknown.status).toBe(404)

    const crossScope = await fetch(`${base}/sessions/${session.id}/project/icon`, {
      headers: { authorization: 'Bearer carol' },
    })
    expect(crossScope.status).toBe(404)
    expect(await crossScope.text()).toBe(expected)

    const own = await fetch(`${base}/sessions/${session.id}/project/icon`, {
      headers: { authorization: 'Bearer alice' },
    })
    expect(own.status).toBe(200)
  })
})

describe('ProjectInfoService cache', () => {
  const infoFor = (cwd: string): SessionInfo =>
    ({ id: 's', status: 'idle', cwd, createdAt: 0, lastSeq: 0, pendingPermissionCount: 0 }) as SessionInfo

  it('serves from cache inside the TTL and re-reads after it', async () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ name: 'Before' }))

    const cached = new ProjectInfoService() // default TTL — the second read must not walk
    expect((cached.withProject(infoFor(repo)).project as ProjectInfo).name).toBe('Before')
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ name: 'After' }))
    expect((cached.withProject(infoFor(repo)).project as ProjectInfo).name).toBe('Before')

    const expiring = new ProjectInfoService({ ttlMs: 0 })
    expect((expiring.withProject(infoFor(repo)).project as ProjectInfo).name).toBe('After')
    writeFileSync(join(repo, '.workerdeck.json'), JSON.stringify({ name: 'Again' }))
    expect((expiring.withProject(infoFor(repo)).project as ProjectInfo).name).toBe('Again')
  })

  it('returns the same object when there is nothing to add', () => {
    const service = new ProjectInfoService()
    const bare = infoFor('')
    expect(service.withProject(bare)).toBe(bare)
    const nowhere = infoFor(join(tempRoot(), 'nothing-here'))
    expect(service.withProject(nowhere)).toBe(nowhere)
  })
})

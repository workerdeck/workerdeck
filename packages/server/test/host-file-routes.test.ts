import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

/**
 * The `/fs/*` routes end to end. The containment core has its own adversarial
 * suite (`host-files.test.ts`); this one is about the door in front of it — that
 * the routes are absent unless configured, that writes are conditional, and that
 * a refusal from the core still reaches the client as a status code.
 */

let running: WorkerServer | undefined
let root: string
let outside: string

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

beforeEach(() => {
  // realpath because macOS's tmpdir is itself a symlink — the server answers with
  // canonical paths, so the expectations have to be canonical too.
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'wd-fs-')))
  root = join(box, 'project')
  outside = join(box, 'secrets')
  mkdirSync(root)
  mkdirSync(outside)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'README.md'), '# hello\n')
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY\n')
})

afterEach(async () => {
  await running?.close()
  running = undefined
  if (root) rmSync(join(root, '..'), { recursive: true, force: true })
})

async function start(
  hostFiles?: { roots?: string[]; write?: boolean; maxFileBytes?: number },
  allowedCwdRoots?: string[],
) {
  running = createWorkerServer({ allowUnauthenticated: true, hostFiles, allowedCwdRoots })
  const { port } = await running.listen(0, '127.0.0.1')
  return `http://127.0.0.1:${port}/v1`
}

const get = async (base: string, path: string): Promise<[number, any]> => {
  const res = await fetch(`${base}${path}`)
  return [res.status, await res.json()]
}

describe('host file routes', () => {
  it('404s the whole surface when there is no cwd policy and no roots', async () => {
    const base = await start()
    for (const path of ['/fs/roots', '/fs/list?path=/tmp', '/fs/read?path=/tmp/x']) {
      const [status, body] = await get(base, path)
      expect(status).toBe(404)
      expect(body.error).toMatch(/not configured/)
    }
    const res = await fetch(`${base}/fs/write`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(root, 'x'), content: 'x' }),
    })
    expect(res.status).toBe(404)
    // `allowedCwdRoots` unset means "a session may run anywhere", which is a
    // statement about paths the operator types — never a licence to serve `/`.
  })

  it('serves the cwd roots when hostFiles names none of its own', async () => {
    // A caller who may start a session in a tree can already read that tree
    // through the agent, so reading it over /fs adds no authority.
    const base = await start(undefined, [root])
    const [status, body] = await get(base, '/fs/roots')
    expect(status).toBe(200)
    expect(body.roots).toEqual([{ path: root, name: 'project' }])
    expect((await get(base, `/fs/read?path=${encodeURIComponent(join(root, 'README.md'))}`))[0])
      .toBe(200)
    // Read follows the cwd policy; write is still its own switch.
    expect(body.canWrite).toBe(false)
  })

  it('lets hostFiles.roots narrow the cwd roots rather than extend them', async () => {
    const base = await start({ roots: [join(root, 'src')] }, [root])
    const [, body] = await get(base, '/fs/roots')
    expect(body.roots).toEqual([{ path: join(root, 'src'), name: 'src' }])
    // README.md is inside a *cwd* root but outside the narrower file root.
    expect((await get(base, `/fs/read?path=${encodeURIComponent(join(root, 'README.md'))}`))[0])
      .toBe(404)
  })

  it('an empty roots array is a policy, not an absence', async () => {
    // An operator writing `roots: []` is turning the routes off, and must not
    // fall through to the cwd roots.
    const base = await start({ roots: [] }, [root])
    expect((await get(base, '/fs/roots'))[0]).toBe(404)
  })

  it('enables writes on inherited roots without naming them twice', async () => {
    const base = await start({ write: true }, [root])
    expect((await get(base, '/fs/roots'))[1].canWrite).toBe(true)
  })

  it('advertises its roots and whether it takes writes', async () => {
    const base = await start({ roots: [root] })
    const [status, body] = await get(base, '/fs/roots')
    expect(status).toBe(200)
    expect(body).toEqual({ roots: [{ path: root, name: 'project' }], canWrite: false })

    const writable = await start({ roots: [root], write: true })
    expect((await get(writable, '/fs/roots'))[1].canWrite).toBe(true)
  })

  it('lists a directory, directories first', async () => {
    const base = await start({ roots: [root] })
    const [status, body] = await get(base, `/fs/list?path=${encodeURIComponent(root)}`)
    expect(status).toBe(200)
    expect(body.path).toBe(root)
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['src', 'README.md'])
    expect(body.entries[0].type).toBe('dir')
    expect(body.entries[1]).toMatchObject({ type: 'file', bytes: 8 })
  })

  it('reports a symlink as itself and refuses to read one that escapes', async () => {
    symlinkSync(outside, join(root, 'escape'))
    const base = await start({ roots: [root] })
    const [, listing] = await get(base, `/fs/list?path=${encodeURIComponent(root)}`)
    const link = listing.entries.find((e: { name: string }) => e.name === 'escape')
    // Listed, and listed as a link — never silently resolved into the tree.
    expect(link.type).toBe('symlink')

    const [status] = await get(
      base,
      `/fs/list?path=${encodeURIComponent(join(root, 'escape'))}`,
    )
    expect(status).toBeGreaterThanOrEqual(400)
    const [readStatus] = await get(
      base,
      `/fs/read?path=${encodeURIComponent(join(root, 'escape', 'id_rsa'))}`,
    )
    expect(readStatus).toBeGreaterThanOrEqual(400)
  })

  it('refuses a path outside the roots, and `..` that climbs out', async () => {
    const base = await start({ roots: [root] })
    expect((await get(base, `/fs/read?path=${encodeURIComponent(join(outside, 'id_rsa'))}`))[0])
      .toBeGreaterThanOrEqual(400)
    expect(
      (await get(base, `/fs/read?path=${encodeURIComponent(join(root, '..', 'secrets', 'id_rsa'))}`))[0],
    ).toBeGreaterThanOrEqual(400)
  })

  it('reads a text file with the hash a write will need', async () => {
    const base = await start({ roots: [root] })
    const [status, body] = await get(
      base,
      `/fs/read?path=${encodeURIComponent(join(root, 'README.md'))}`,
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({
      path: join(root, 'README.md'),
      content: '# hello\n',
      encoding: 'utf8',
      bytes: 8,
      hash: sha256('# hello\n'),
    })
  })

  it('ships non-text as base64 rather than corrupting it', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    const base = await start({ roots: [root] })
    const [, body] = await get(base, `/fs/read?path=${encodeURIComponent(join(root, 'blob.bin'))}`)
    expect(body.encoding).toBe('base64')
    expect(Buffer.from(body.content, 'base64')).toEqual(Buffer.from([0xff, 0xfe, 0x00, 0x01]))
  })

  it('413s a file over the cap instead of streaming it to a phone', async () => {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(2048))
    const base = await start({ roots: [root], maxFileBytes: 1024 })
    const [status] = await get(base, `/fs/read?path=${encodeURIComponent(join(root, 'big.txt'))}`)
    expect(status).toBe(413)
  })

  describe('find', () => {
    const find = async (base: string, dir: string, q = '', limit?: number) => {
      const search = new URLSearchParams({ path: dir, q })
      if (limit !== undefined) search.set('limit', String(limit))
      const [status, body] = await get(base, `/fs/find?${search.toString()}`)
      expect(status).toBe(200)
      return body
    }

    it('matches a subsequence, ranking filename hits above path hits', async () => {
      mkdirSync(join(root, 'src', 'sessions'), { recursive: true })
      writeFileSync(join(root, 'src', 'sessions', 'SessionListView.swift'), 'x')
      writeFileSync(join(root, 'src', 'sessions', 'other.swift'), 'x')
      const base = await start({ roots: [root] })

      const body = await find(base, root, 'seslist')
      // 'other.swift' lives under a path containing 's','e','s'… but the hit in
      // the *name* is the one a person means.
      expect(body.matches[0].relative).toBe(join('src', 'sessions', 'SessionListView.swift'))
    })

    it('returns the shallowest files for an empty query', async () => {
      mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
      writeFileSync(join(root, 'a', 'b', 'c', 'deep.txt'), 'x')
      const base = await start({ roots: [root] })

      const body = await find(base, root)
      expect(body.base).toBe(root)
      expect(body.matches[0].relative).toBe('README.md')
      expect(body.matches.at(-1)?.relative).toBe(join('a', 'b', 'c', 'deep.txt'))
    })

    it('skips build directories and anything behind a symlink', async () => {
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
      symlinkSync(outside, join(root, 'escape'))
      const base = await start({ roots: [root] })

      const body = await find(base, root)
      const paths: string[] = body.matches.map((m: { relative: string }) => m.relative)
      expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
      // Never offer a path a later /fs/read would refuse.
      expect(paths.some((p) => p.includes('escape'))).toBe(false)
    })

    it('truncates rather than erroring, and clamps an absurd limit', async () => {
      for (let i = 0; i < 12; i++) writeFileSync(join(root, `f${i}.txt`), 'x')
      const base = await start({ roots: [root] })

      const body = await find(base, root, '', 5)
      expect(body.matches).toHaveLength(5)
      expect(body.truncated).toBe(true)
      expect((await find(base, root, '', 99_999)).matches.length).toBeLessThanOrEqual(200)
    })

    it('refuses a directory outside the roots, and a file as the search base', async () => {
      const base = await start({ roots: [root] })
      expect((await get(base, `/fs/find?path=${encodeURIComponent(outside)}`))[0])
        .toBeGreaterThanOrEqual(400)
      const [status, body] = await get(
        base,
        `/fs/find?path=${encodeURIComponent(join(root, 'README.md'))}`,
      )
      expect(status).toBe(400)
      expect(body.error).toBe('not a directory')
    })
  })

  it('refuses writes unless they are enabled', async () => {
    const base = await start({ roots: [root] })
    const res = await fetch(`${base}/fs/write`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(root, 'README.md'), content: 'nope', expectedHash: sha256('# hello\n') }),
    })
    expect(res.status).toBe(403)
  })

  describe('with writes enabled', () => {
    const write = async (base: string, body: unknown): Promise<[number, any]> => {
      const res = await fetch(`${base}/fs/write`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return [res.status, await res.json()]
    }

    it('creates a file only when no hash is offered', async () => {
      const base = await start({ roots: [root], write: true })
      const path = join(root, 'src', 'new.ts')
      const [status, body] = await write(base, { path, content: 'export const y = 2\n' })
      expect(status).toBe(200)
      expect(body).toMatchObject({ path, bytes: 19, hash: sha256('export const y = 2\n') })

      // Creating over an existing file is the mistake the precondition exists for.
      const [again, err] = await write(base, { path, content: 'clobber' })
      expect(again).toBe(409)
      expect(err.error).toMatch(/expectedHash/)
    })

    it('overwrites only against the hash that was read', async () => {
      const base = await start({ roots: [root], write: true })
      const path = join(root, 'README.md')
      const [stale] = await write(base, { path, content: 'new', expectedHash: sha256('something else') })
      expect(stale).toBe(409)

      const [ok, body] = await write(base, { path, content: '# bye\n', expectedHash: sha256('# hello\n') })
      expect(ok).toBe(200)
      // The write's own hash chains into the next edit without a re-read.
      const [second] = await write(base, { path, content: '# again\n', expectedHash: body.hash })
      expect(second).toBe(200)
    })

    it('409s a hash offered for a file that is gone, and 404s a missing parent', async () => {
      const base = await start({ roots: [root], write: true })
      expect(
        (await write(base, { path: join(root, 'ghost.md'), content: 'x', expectedHash: sha256('x') }))[0],
      ).toBe(409)
      expect((await write(base, { path: join(root, 'nodir', 'x.md'), content: 'x' }))[0]).toBe(404)
    })

    it('will not write through a symlink that escapes the roots', async () => {
      symlinkSync(join(outside, 'id_rsa'), join(root, 'key'))
      const base = await start({ roots: [root], write: true })
      const [status] = await write(base, {
        path: join(root, 'key'),
        content: 'pwned',
        expectedHash: sha256('PRIVATE KEY\n'),
      })
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).not.toBe(200)
    })
  })

  it('answers 401 before it answers "not configured"', async () => {
    // Otherwise an unauthenticated probe learns whether this gateway exposes a
    // filesystem at all.
    running = createWorkerServer({
      authenticate: (req) => (req.headers.authorization === 'Bearer k' ? { ok: true } : null),
      hostFiles: { roots: [root] },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    expect((await fetch(`${base}/fs/roots`)).status).toBe(401)
    const authed = await fetch(`${base}/fs/roots`, { headers: { authorization: 'Bearer k' } })
    expect(authed.status).toBe(200)
  })
})

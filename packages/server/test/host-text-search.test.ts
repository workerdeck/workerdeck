import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { searchGlobs, type HostSearchEvent, type HostSearchFile, type HostSearchRequest } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { resolveRipgrep } from '../src/services/host-text-search.ts'

const rg = resolveRipgrep()

let box: string
let root: string
let running: WorkerServer | undefined

beforeAll(() => {
  box = realpathSync(mkdtempSync(join(tmpdir(), 'wd-search-')))
  root = join(box, 'project')
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, 'build'))
  mkdirSync(join(box, 'secrets'))
  writeFileSync(join(root, 'README.md'), '# Hello\nhello world\n')
  writeFileSync(join(root, 'src', 'index.ts'), 'export const hello = 1\nconst helloWorld = hello + 1\n')
  writeFileSync(join(root, 'src', 'deep', 'emoji.ts'), '// \u{1F600}\u{1F600} hello\n')
  writeFileSync(join(root, 'build', 'out.js'), 'hello from build\n')
  writeFileSync(join(root, '.gitignore'), 'build/\n')
  writeFileSync(join(root, '.env'), 'HELLO=1\n')
  writeFileSync(join(box, 'secrets', 'key.txt'), 'hello secret\n')
  symlinkSync(join(box, 'secrets'), join(root, 'escape'))
  execFileSync('git', ['init', '-q'], { cwd: root })
})

afterAll(() => {
  rmSync(box, { recursive: true, force: true })
})

afterEach(async () => {
  await running?.close()
  running = undefined
})

async function start(ripgrep?: string | false): Promise<string> {
  running = createWorkerServer({ allowUnauthenticated: true, hostFiles: { roots: [root], ripgrep } })
  const { port } = await running.listen(0, '127.0.0.1')
  return `http://127.0.0.1:${port}/v1`
}

async function search(base: string, request: Partial<HostSearchRequest>): Promise<HostSearchEvent[]> {
  const res = await fetch(`${base}/fs/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: root, ...request, excludes: ['**/.git', ...(request.excludes ?? [])] }),
  })
  expect(res.status).toBe(200)
  return (await res.text())
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as HostSearchEvent)
}

function filesOf(events: HostSearchEvent[]): HostSearchFile[] {
  return events.filter((e): e is HostSearchFile => e.type === 'file').sort((a, b) => a.relative.localeCompare(b.relative))
}

function done(events: HostSearchEvent[]): HostSearchEvent | undefined {
  return events.at(-1)
}

describe.skipIf(!rg)('POST /fs/search', () => {
  it('finds literal text case-insensitively by default, honouring .gitignore and skipping links', async () => {
    const base = await start()
    const events = await search(base, { query: 'hello' })
    expect(filesOf(events).map((f) => f.relative)).toEqual(['.env', 'README.md', 'src/deep/emoji.ts', 'src/index.ts'])
    expect(done(events)).toEqual({ type: 'done', files: 4, matches: 7, truncated: false })
    const readme = filesOf(events).find((f) => f.relative === 'README.md')!
    expect(readme.path).toBe(join(root, 'README.md'))
    expect(readme.lines.map((l) => [l.line, l.text, l.matches.map((m) => [m.column, m.endColumn, m.text])])).toEqual([
      [0, '# Hello', [[2, 7, 'Hello']]],
      [1, 'hello world', [[0, 5, 'hello']]],
    ])
  })

  it('reports columns in UTF-16 code units', async () => {
    const base = await start()
    const emoji = filesOf(await search(base, { query: 'hello' })).find((f) => f.relative === 'src/deep/emoji.ts')!
    expect(emoji.lines[0]!.matches[0]).toMatchObject({ line: 0, column: 8, endLine: 0, endColumn: 13 })
  })

  it('applies match case, whole word and regex', async () => {
    const base = await start()
    expect(done(await search(base, { query: 'Hello', matchCase: true }))).toMatchObject({ matches: 1 })
    expect(done(await search(base, { query: 'hello', wholeWord: true }))).toMatchObject({ matches: 6 })
    const regex = filesOf(await search(base, { query: 'hello(World)?\\b', isRegex: true, matchCase: true }))
    expect(regex.find((f) => f.relative === 'src/index.ts')!.lines[1]!.matches.map((m) => m.text)).toEqual(['helloWorld', 'hello'])
  })

  it('turns a bad regex into an error event', async () => {
    const base = await start()
    const [event] = await search(base, { query: '(unclosed', isRegex: true })
    expect(event).toMatchObject({ type: 'error' })
    expect((event as { message: string }).message).toMatch(/regex/i)
  })

  it('takes include and exclude globs as VS Code spells them', async () => {
    const base = await start()
    const included = await search(base, { query: 'hello', includes: searchGlobs('src') })
    expect(filesOf(included).map((f) => f.relative)).toEqual(['src/deep/emoji.ts', 'src/index.ts'])
    const excluded = await search(base, { query: 'hello', excludes: searchGlobs('deep, *.md') })
    expect(filesOf(excluded).map((f) => f.relative)).toEqual(['.env', 'src/index.ts'])
    const anchored = await search(base, { query: 'hello', includes: searchGlobs(`${root}/src/deep`, root) })
    expect(filesOf(anchored).map((f) => f.relative)).toEqual(['src/deep/emoji.ts'])
  })

  it('searches ignored files when ignore files are off, still without following links', async () => {
    const base = await start()
    const events = await search(base, { query: 'hello', useIgnoreFiles: false })
    expect(filesOf(events).map((f) => f.relative)).toEqual(['.env', 'build/out.js', 'README.md', 'src/deep/emoji.ts', 'src/index.ts'])
  })

  it('matches a literal query across lines', async () => {
    const base = await start()
    const [file] = filesOf(await search(base, { query: '# Hello\nhello' }))
    expect(file!.relative).toBe('README.md')
    expect(file!.lines[0]!.matches[0]).toMatchObject({ line: 0, column: 0, endLine: 1, endColumn: 5, text: '# Hello\nhello' })
  })

  it('stops at maxResults and says so', async () => {
    const base = await start()
    const events = await search(base, { query: 'hello', maxResults: 2 })
    expect(done(events)).toMatchObject({ type: 'done', matches: 2, truncated: true })
    expect(filesOf(events).flatMap((f) => f.lines.flatMap((l) => l.matches))).toHaveLength(2)
  })

  it('refuses paths outside the roots like every other /fs route', async () => {
    const base = await start()
    const res = await fetch(`${base}/fs/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(box, 'secrets'), query: 'hello' }),
    })
    expect(res.status).toBe(404)
    const through = await fetch(`${base}/fs/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(root, 'escape'), query: 'hello' }),
    })
    expect(through.status).toBe(404)
  })

  it('validates the query', async () => {
    const base = await start()
    for (const body of [{ query: '' }, { query: 'x', isRegex: 'yes' }, { query: 'x', includes: 'src' }]) {
      const res = await fetch(`${base}/fs/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: root, ...body }),
      })
      expect(res.status).toBe(400)
    }
  })
})

describe('search availability', () => {
  it('says so on /fs/roots and answers 501 when ripgrep is off', async () => {
    const base = await start(false)
    const roots = (await (await fetch(`${base}/fs/roots`)).json()) as { canSearch?: boolean }
    expect(roots.canSearch).toBe(false)
    const res = await fetch(`${base}/fs/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root, query: 'hello' }),
    })
    expect(res.status).toBe(501)
  })
})

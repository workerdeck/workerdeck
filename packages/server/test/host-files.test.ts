import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createHostFileRoots,
  entryKind,
  readContained,
  resolveExisting,
  resolveForWrite,
  writeContained,
  type HostFileRoots,
} from '../src/host-files.ts'

const posix = process.platform !== 'win32'

// The tree lives under os.tmpdir(), which on macOS is itself a symlink
// (/var/folders/... -> /private/var/...). The root is configured in the
// symlinky spelling on purpose: a resolver that realpaths targets but not the
// root fails every containment check on this machine.
let base: string
let root: string
let canonicalRoot: string
let roots: HostFileRoots

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'wd-hostfs-'))
  root = join(base, 'app')
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'file.txt'), 'contained')
  writeFileSync(join(root, 'sub', 'nested.txt'), 'nested')
  writeFileSync(join(root, 'real.txt'), 'real')
  writeFileSync(join(base, 'outside.txt'), 'outside')
  // Prefix sibling of the root: same string prefix, different directory.
  mkdirSync(join(base, 'application'))
  writeFileSync(join(base, 'application', 'f.txt'), 'sibling')
  mkdirSync(join(base, 'outside-dir'))
  writeFileSync(join(base, 'outside-dir', 'b.txt'), 'escaped')

  symlinkSync(join(root, 'file.txt'), join(root, 'inside-link'))
  symlinkSync(join(root, 'real.txt'), join(root, 'real-link'))
  symlinkSync('sub', join(root, 'dir-link'))
  symlinkSync(join(base, 'outside.txt'), join(root, 'out-link'))
  symlinkSync('/etc/hosts', join(root, 'abs-out-link'))
  symlinkSync(join(base, 'outside-dir'), join(root, 'escape-dir'))
  symlinkSync(join(root, 'missing.txt'), join(root, 'dangling'))
  symlinkSync(root, join(base, 'rootlink'))
  if (posix) execFileSync('mkfifo', [join(root, 'pipe')])

  canonicalRoot = realpathSync(root)
  roots = createHostFileRoots([root])
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const REFUSED = { ok: false, status: 404, error: 'not found' }

describe('createHostFileRoots', () => {
  it('rejects misdeclared roots at construction', () => {
    expect(() => createHostFileRoots([join(base, 'nope')])).toThrow(/does not exist/)
    expect(() => createHostFileRoots([join(root, 'file.txt')])).toThrow(/not a directory/)
    expect(() => createHostFileRoots(['relative/root'])).toThrow(/absolute/)
    expect(() => createHostFileRoots([''])).toThrow(/absolute/)
  })

  it('canonicalizes roots so a symlinky spelling still contains its tree', () => {
    expect(roots.roots[0]!.canonical).toBe(canonicalRoot)
    // A root that is ITSELF a symlink guards the resolved tree.
    const viaLink = createHostFileRoots([join(base, 'rootlink')])
    expect(resolveExisting(viaLink, join(base, 'rootlink', 'file.txt'))).toEqual({
      ok: true,
      path: join(canonicalRoot, 'file.txt'),
      root: canonicalRoot,
      kind: 'file',
    })
  })
})

describe('resolveExisting', () => {
  it('resolves a contained file, the root itself, and nested paths', () => {
    expect(resolveExisting(roots, join(root, 'file.txt'))).toEqual({
      ok: true,
      path: join(canonicalRoot, 'file.txt'),
      root: canonicalRoot,
      kind: 'file',
    })
    expect(resolveExisting(roots, root)).toEqual({
      ok: true,
      path: canonicalRoot,
      root: canonicalRoot,
      kind: 'dir',
    })
    expect(resolveExisting(roots, join(root, 'sub', 'nested.txt'))).toMatchObject({
      ok: true,
      path: join(canonicalRoot, 'sub', 'nested.txt'),
      kind: 'file',
    })
    // The canonical spelling works too.
    expect(resolveExisting(roots, join(canonicalRoot, 'file.txt'))).toMatchObject({ ok: true })
  })

  it('refuses .. traversal that leaves the root, allows one that returns', () => {
    expect(resolveExisting(roots, join(root, '..', 'outside.txt'))).toEqual(REFUSED)
    expect(resolveExisting(roots, join(root, 'sub', '..', '..', 'outside.txt'))).toEqual(REFUSED)
    // Physical resolution, not lexical: this lands back on a contained file.
    expect(resolveExisting(roots, join(root, 'sub', '..', 'file.txt'))).toMatchObject({
      ok: true,
      path: join(canonicalRoot, 'file.txt'),
    })
  })

  it('refuses symlinks pointing out of the root', () => {
    expect(resolveExisting(roots, join(root, 'out-link'))).toEqual(REFUSED)
    expect(resolveExisting(roots, join(root, 'abs-out-link'))).toEqual(REFUSED)
  })

  it('follows symlinks that resolve inside the root', () => {
    expect(resolveExisting(roots, join(root, 'inside-link'))).toMatchObject({
      ok: true,
      path: join(canonicalRoot, 'file.txt'),
    })
    expect(resolveExisting(roots, join(root, 'dir-link', 'nested.txt'))).toMatchObject({
      ok: true,
      path: join(canonicalRoot, 'sub', 'nested.txt'),
    })
  })

  it('refuses a symlinked parent directory that escapes', () => {
    expect(resolveExisting(roots, join(root, 'escape-dir', 'b.txt'))).toEqual(REFUSED)
  })

  it('answers escape, dangling link, and plain absence identically', () => {
    const escape = resolveExisting(roots, join(root, 'out-link'))
    const dangling = resolveExisting(roots, join(root, 'dangling'))
    const absent = resolveExisting(roots, join(root, 'no-such.txt'))
    const outside = resolveExisting(roots, '/etc/hosts')
    expect(escape).toEqual(REFUSED)
    expect(dangling).toEqual(escape)
    expect(absent).toEqual(escape)
    expect(outside).toEqual(escape)
  })

  it('does not confuse a prefix sibling with the root', () => {
    expect(resolveExisting(roots, join(base, 'application', 'f.txt'))).toEqual(REFUSED)
  })

  it('refuses invalid requests without touching the filesystem', () => {
    expect(resolveExisting(roots, 'file.txt')).toMatchObject({ ok: false, status: 403 })
    expect(resolveExisting(roots, '')).toMatchObject({ ok: false, status: 403 })
    expect(resolveExisting(roots, `${root}/a\0b`)).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses everything under an empty root list', () => {
    const none = createHostFileRoots([])
    expect(resolveExisting(none, join(root, 'file.txt'))).toEqual(REFUSED)
    expect(resolveForWrite(none, join(root, 'new.txt'))).toEqual(REFUSED)
  })

  it.runIf(posix)('refuses a fifo inside the root', () => {
    expect(resolveExisting(roots, join(root, 'pipe'))).toEqual({
      ok: false,
      status: 403,
      error: 'not a regular file or directory',
    })
  })
})

describe('resolveForWrite', () => {
  it('allows a new file under the root and under a subdirectory', () => {
    expect(resolveForWrite(roots, join(root, 'new.txt'))).toEqual({
      ok: true,
      path: join(canonicalRoot, 'new.txt'),
      root: canonicalRoot,
      kind: 'file',
    })
    expect(resolveForWrite(roots, join(root, 'sub', 'new.txt'))).toMatchObject({
      ok: true,
      path: join(canonicalRoot, 'sub', 'new.txt'),
    })
  })

  it('allows overwriting an existing contained file', () => {
    expect(resolveForWrite(roots, join(root, 'file.txt'))).toMatchObject({
      ok: true,
      path: join(canonicalRoot, 'file.txt'),
    })
  })

  it('writes through a symlink that resolves inside the root', () => {
    const out = resolveForWrite(roots, join(root, 'real-link'))
    expect(out).toMatchObject({ ok: true, path: join(canonicalRoot, 'real.txt') })
    if (!out.ok) return
    expect(writeContained(out.path, 'updated')).toEqual({ ok: true })
    expect(readFileSync(join(root, 'real.txt'), 'utf8')).toBe('updated')
  })

  it('allows a new file whose parent is an inside symlink', () => {
    expect(resolveForWrite(roots, join(root, 'dir-link', 'via-link.txt'))).toMatchObject({
      ok: true,
      path: join(canonicalRoot, 'sub', 'via-link.txt'),
    })
  })

  it('refuses when the parent does not exist or is a file', () => {
    expect(resolveForWrite(roots, join(root, 'nope', 'new.txt'))).toEqual(REFUSED)
    expect(resolveForWrite(roots, join(root, 'file.txt', 'new.txt'))).toEqual(REFUSED)
  })

  it('refuses escaping targets and parents, existing or not', () => {
    expect(resolveForWrite(roots, join(root, 'out-link'))).toEqual(REFUSED)
    expect(resolveForWrite(roots, join(root, 'escape-dir', 'b.txt'))).toEqual(REFUSED)
    expect(resolveForWrite(roots, join(root, 'escape-dir', 'new.txt'))).toEqual(REFUSED)
    expect(resolveForWrite(roots, join(root, '..', 'outside.txt'))).toEqual(REFUSED)
  })

  it('refuses a dangling symlink target, identically to an escaping one', () => {
    const dangling = resolveForWrite(roots, join(root, 'dangling'))
    expect(dangling).toEqual(REFUSED)
    expect(dangling).toEqual(resolveForWrite(roots, join(root, 'out-link')))
  })

  it('refuses directories and invalid requests', () => {
    expect(resolveForWrite(roots, root)).toEqual({ ok: false, status: 403, error: 'is a directory' })
    expect(resolveForWrite(roots, join(root, 'sub'))).toMatchObject({ ok: false, status: 403 })
    expect(resolveForWrite(roots, 'new.txt')).toMatchObject({ ok: false, status: 403 })
    expect(resolveForWrite(roots, '')).toMatchObject({ ok: false, status: 403 })
    expect(resolveForWrite(roots, `${root}/new\0.txt`)).toMatchObject({ ok: false, status: 403 })
    expect(resolveForWrite(roots, join(root, 'sub', '..'))).toMatchObject({ ok: false })
  })

  it.runIf(posix)('refuses a fifo as a write target', () => {
    expect(resolveForWrite(roots, join(root, 'pipe'))).toEqual({
      ok: false,
      status: 403,
      error: 'not a regular file',
    })
  })
})

describe('readContained / writeContained', () => {
  it('round-trips a write and a read through resolved paths', () => {
    const target = resolveForWrite(roots, join(root, 'roundtrip.txt'))
    expect(target).toMatchObject({ ok: true })
    if (!target.ok) return
    expect(writeContained(target.path, 'hello')).toEqual({ ok: true })

    const read = resolveExisting(roots, join(root, 'roundtrip.txt'))
    expect(read).toMatchObject({ ok: true, kind: 'file' })
    if (!read.ok) return
    expect(readContained(read.path)).toEqual({ ok: true, data: Buffer.from('hello') })
  })

  it('answers 404 for a file that vanished after resolve', () => {
    expect(readContained(join(canonicalRoot, 'vanished.txt'))).toEqual(REFUSED)
  })

  it.runIf(posix)('refuses a fifo without hanging', () => {
    // The no-hang guarantee: O_NONBLOCK opens the reader-less fifo instantly,
    // the fstat gate refuses it. A blocking open here would park the test forever.
    expect(readContained(join(root, 'pipe'))).toMatchObject({ ok: false, status: 403 })
    expect(writeContained(join(root, 'pipe'), 'x')).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses reading a directory', () => {
    expect(readContained(canonicalRoot)).toMatchObject({ ok: false, status: 403 })
  })
})

describe('entryKind', () => {
  it('classifies with lstat semantics, never following links', () => {
    const kinds = new Map(
      readdirSync(root, { withFileTypes: true }).map((e) => [e.name, entryKind(e)]),
    )
    expect(kinds.get('file.txt')).toBe('file')
    expect(kinds.get('sub')).toBe('dir')
    expect(kinds.get('inside-link')).toBe('symlink')
    expect(kinds.get('out-link')).toBe('symlink')
    expect(kinds.get('dangling')).toBe('symlink')
    expect(kinds.get('dir-link')).toBe('symlink')
    if (posix) expect(kinds.get('pipe')).toBe('other')
  })
})

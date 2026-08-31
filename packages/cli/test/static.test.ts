import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentTypeFor, looksLikeAsset, resolveWithinRoot } from '../src/lib/static.ts'

describe('resolveWithinRoot', () => {
  const root = '/srv/web'

  it('resolves ordinary asset paths', () => {
    expect(resolveWithinRoot(root, '/assets/index-abc123.js')).toBe(resolve('/srv/web/assets/index-abc123.js'))
  })

  it('refuses to escape the root', () => {
    expect(resolveWithinRoot(root, '/../../etc/passwd')).toBeNull()
    expect(resolveWithinRoot(root, '/assets/../../../etc/passwd')).toBeNull()
  })

  it('refuses an escape hidden in percent-encoding', () => {
    expect(resolveWithinRoot(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
  })

  it('allows traversal that stays inside the root', () => {
    expect(resolveWithinRoot(root, '/assets/../index.html')).toBe(resolve('/srv/web/index.html'))
  })

  it('refuses malformed encoding and NUL bytes rather than guessing', () => {
    expect(resolveWithinRoot(root, '/%zz')).toBeNull()
    expect(resolveWithinRoot(root, '/a%00.js')).toBeNull()
  })

  it('does not treat a sibling directory with the same prefix as inside', () => {
    expect(resolveWithinRoot('/srv/web', '/../web-secrets/key.txt')).toBeNull()
  })
})

describe('looksLikeAsset', () => {
  it('is true for known static extensions', () => {
    for (const p of ['/assets/a-1.js', '/favicon.svg', '/x.woff2', '/g.wasm', '/index.html']) {
      expect(looksLikeAsset(p)).toBe(true)
    }
  })

  it('is false for app routes, which must fall through to the entry document', () => {
    for (const p of ['/', '/sessions', '/settings/profiles']) {
      expect(looksLikeAsset(p)).toBe(false)
    }
  })

  it('is false for an unknown extension, so it is served as a document not a download', () => {
    expect(looksLikeAsset('/report.pdf')).toBe(false)
  })
})

describe('contentTypeFor', () => {
  it('maps the types the dashboard actually ships', () => {
    expect(contentTypeFor('/a.js')).toMatch(/text\/javascript/)
    expect(contentTypeFor('/a.css')).toMatch(/text\/css/)
    expect(contentTypeFor('/a.woff2')).toBe('font/woff2')
    expect(contentTypeFor('/a.wasm')).toBe('application/wasm')
  })

  it('falls back to octet-stream rather than guessing', () => {
    expect(contentTypeFor('/a.xyz')).toBe('application/octet-stream')
    expect(contentTypeFor('/noext')).toBe('application/octet-stream')
  })
})

describe('the bundled dashboard contract', () => {
  it('serves index.html for a path with no extension (hash history)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-web-'))
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>x</title>')
    expect(resolveWithinRoot(dir, '/index.html')).toBe(resolve(dir, 'index.html'))
    expect(looksLikeAsset('/sessions/abc')).toBe(false)
  })
})

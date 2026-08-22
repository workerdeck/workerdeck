import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { parseProjectTrustEntries, untrustedProjectNotice } from '../src/engines/codex/trust.ts'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import type { AppServerConnectFn } from '../src/engines/codex/types.ts'

const roots: string[] = []
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A fresh sandbox dir. `mkdtemp` under macOS's tmpdir returns a symlinked
 * spelling (`/var/...` → `/private/var/...`), so every test here exercises the
 * canonicalization rule for free. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-codex-trust-'))
  roots.push(dir)
  return dir
}

/** `<dir>/.codex/config.toml` declaring one MCP server — the project config
 * whose silent loss this whole feature is about. */
function projectConfig(dir: string): string {
  mkdirSync(join(dir, '.codex'), { recursive: true })
  const path = join(dir, '.codex', 'config.toml')
  writeFileSync(path, '[mcp_servers.probe]\ncommand = "echo"\n')
  return path
}

/** A codex home whose config.toml carries the given trust entries, written the
 * way codex itself writes them. */
function codexHome(entries: Array<{ path: string; level: string }> = []): string {
  const home = join(tempDir(), 'home')
  mkdirSync(home, { recursive: true })
  const body = entries
    .map((e) => `[projects."${e.path}"]\ntrust_level = "${e.level}"\n`)
    .join('\n')
  writeFileSync(join(home, 'config.toml'), body)
  return home
}

describe('parseProjectTrustEntries', () => {
  it('reads the form codex itself writes', () => {
    const entries = parseProjectTrustEntries(
      '[projects."/Users/me/proj"]\ntrust_level = "trusted"\n',
    )
    expect(entries?.get('/Users/me/proj')).toBe('trusted')
  })

  it('tolerates comments, blank lines, CRLF and whitespace around dots', () => {
    const entries = parseProjectTrustEntries(
      '# header\r\n\r\n[ projects . "/a/b" ]  # trailing\r\n' +
        '  trust_level = "trusted"  # yes\r\n',
    )
    expect(entries?.get('/a/b')).toBe('trusted')
  })

  it('unescapes basic-string keys and accepts literal-string and bare keys', () => {
    const entries = parseProjectTrustEntries(
      '[projects."/a/\\"b\\"/\\\\c/\\u0041"]\ntrust_level = "trusted"\n' +
        "[projects.'/lit/path']\ntrust_level = 'untrusted'\n" +
        '[projects.bare-key]\ntrust_level = "trusted"\n',
    )
    expect(entries?.get('/a/"b"/\\c/A')).toBe('trusted')
    expect(entries?.get('/lit/path')).toBe('untrusted')
    // The bare form names a relative path, which can never match an absolute
    // cwd — but it must parse rather than refuse the file.
    expect(entries?.get('bare-key')).toBe('trusted')
  })

  it('reads dotted-key forms: [projects] sections and top-level assignments', () => {
    const entries = parseProjectTrustEntries(
      '[projects]\n"/a".trust_level = "trusted"\n',
    )
    expect(entries?.get('/a')).toBe('trusted')
    const topLevel = parseProjectTrustEntries('projects."/b".trust_level = "untrusted"\n')
    expect(topLevel?.get('/b')).toBe('untrusted')
  })

  it('ignores unrelated sections, non-trust keys, and project sub-tables', () => {
    const entries = parseProjectTrustEntries(
      '[mcp_servers.x]\ncommand = "echo"\ntrust_level = "trusted"\n' +
        '[projects."/a"]\nother = 5\ntrust_level = "trusted"\n' +
        '[projects."/a".meta]\ntrust_level = "untrusted"\n',
    )
    expect(entries?.size).toBe(1)
    expect(entries?.get('/a')).toBe('trusted')
  })

  it('parses multi-line arrays elsewhere — even ones whose strings look like trust entries', () => {
    const entries = parseProjectTrustEntries(
      '[mcp_servers.x]\nargs = [\n  "-y",\n  "[projects.\\"/evil\\"]",\n  "trust_level = \\"trusted\\"",\n]\n' +
        '[projects."/a"]\ntrust_level = "trusted"\n',
    )
    expect(entries?.size).toBe(1)
    expect(entries?.get('/a')).toBe('trusted')
    expect(entries?.get('/evil')).toBeUndefined()
  })

  it('tolerates duplicate agreeing entries and refuses conflicting ones', () => {
    const agree = parseProjectTrustEntries(
      'projects."/a".trust_level = "trusted"\nprojects."/a".trust_level = "trusted"\n',
    )
    expect(agree?.get('/a')).toBe('trusted')
    const conflict = parseProjectTrustEntries(
      'projects."/a".trust_level = "trusted"\nprojects."/a".trust_level = "untrusted"\n',
    )
    expect(conflict).toBeUndefined()
  })

  it('returns an empty map for an empty file', () => {
    expect(parseProjectTrustEntries('')?.size).toBe(0)
  })

  it('refuses whole-entry forms it does not interpret', () => {
    // A trust_level could hide inside any of these; guessing risks a false notice.
    expect(parseProjectTrustEntries('projects = { "/a" = { trust_level = "trusted" } }\n')).toBeUndefined()
    expect(parseProjectTrustEntries('[projects]\n"/a" = { trust_level = "trusted" }\n')).toBeUndefined()
    expect(parseProjectTrustEntries('[[projects."/a"]]\ntrust_level = "trusted"\n')).toBeUndefined()
  })

  it('refuses multi-line strings anywhere — where a line reader starts lying', () => {
    // The body of a multi-line string could be misread as sections and
    // entries, flipping a real verdict; the file is refused instead.
    expect(
      parseProjectTrustEntries('[mcp_servers.x]\nnote = """\n[projects."/a"]\n"""\n'),
    ).toBeUndefined()
    expect(parseProjectTrustEntries("[a]\nnote = '''\ntext\n'''\n")).toBeUndefined()
  })

  it('refuses junk, unterminated values, and non-string trust levels', () => {
    expect(parseProjectTrustEntries('not toml at all\n')).toBeUndefined()
    expect(parseProjectTrustEntries('[projects."/a"\ntrust_level = "trusted"\n')).toBeUndefined()
    expect(parseProjectTrustEntries('[a]\nx = [\n  1,\n')).toBeUndefined()
    expect(parseProjectTrustEntries('[projects."/a"]\ntrust_level = true\n')).toBeUndefined()
    expect(parseProjectTrustEntries('[projects."/a"]\ntrust_level = "trusted" junk\n')).toBeUndefined()
    expect(parseProjectTrustEntries('[projects."/a"]\ntrust_level = "unclosed\n')).toBeUndefined()
    expect(parseProjectTrustEntries('[projects."/a\\q"]\ntrust_level = "trusted"\n')).toBeUndefined()
  })
})

describe('untrustedProjectNotice', () => {
  it('notices an untrusted project config, naming the file, the fix and the home config', () => {
    const proj = tempDir()
    const configPath = projectConfig(proj)
    const home = codexHome()
    const message = untrustedProjectNotice({ cwd: proj, codexHome: home })
    expect(message).toBeDefined()
    expect(message).toContain(configPath)
    // The suggested entry names the canonical path — the only spelling codex matches.
    expect(message).toContain(`[projects."${realpathSync(proj)}"]`)
    expect(message).toContain(join(home, 'config.toml'))
  })

  it('stays silent when there is no project config at all', () => {
    expect(untrustedProjectNotice({ cwd: tempDir(), codexHome: codexHome() })).toBeUndefined()
  })

  it('stays silent for a trusted project, matching entries through realpath', () => {
    const proj = tempDir()
    projectConfig(proj)
    // The entry is written with the symlinked tmpdir spelling; the cwd
    // canonicalizes to /private/... — only realpath'ing both sides matches.
    const home = codexHome([{ path: proj, level: 'trusted' }])
    expect(untrustedProjectNotice({ cwd: proj, codexHome: home })).toBeUndefined()
  })

  it('still notices under an explicit untrusted entry', () => {
    const proj = tempDir()
    projectConfig(proj)
    const home = codexHome([{ path: proj, level: 'untrusted' }])
    expect(untrustedProjectNotice({ cwd: proj, codexHome: home })).toBeDefined()
  })

  it('notices when the home config is absent — knowably no trust entries', () => {
    const proj = tempDir()
    projectConfig(proj)
    const home = join(tempDir(), 'no-such-home')
    expect(untrustedProjectNotice({ cwd: proj, codexHome: home })).toBeDefined()
  })

  it('stays silent on trust levels outside codex vocabulary and on unparseable config', () => {
    const proj = tempDir()
    projectConfig(proj)
    // codex refuses to bootstrap on an unknown variant — that session fails
    // loudly on its own, and a notice on top would be noise at best.
    const weird = codexHome([{ path: proj, level: 'bananas' }])
    expect(untrustedProjectNotice({ cwd: proj, codexHome: weird })).toBeUndefined()
    const broken = join(tempDir(), 'home')
    mkdirSync(broken)
    writeFileSync(join(broken, 'config.toml'), 'note = """\nmulti\n"""\n')
    expect(untrustedProjectNotice({ cwd: proj, codexHome: broken })).toBeUndefined()
  })

  it('inherits trust from the git root across the chain — and discovers ancestor configs', () => {
    const root = tempDir()
    mkdirSync(join(root, '.git'))
    const rootConfig = projectConfig(root)
    const deeper = join(root, 'sub', 'deeper')
    mkdirSync(deeper, { recursive: true })
    // Trusted git root: the whole chain is covered (measured, 0.146.0/0.149.0).
    const trusted = codexHome([{ path: root, level: 'trusted' }])
    expect(untrustedProjectNotice({ cwd: deeper, codexHome: trusted })).toBeUndefined()
    // Untrusted: the ROOT's config is what codex would have loaded from this
    // cwd, so the notice must name it even though the cwd has no .codex.
    const message = untrustedProjectNotice({ cwd: deeper, codexHome: codexHome() })
    expect(message).toContain(rootConfig)
    // And the suggested trust entry targets the git root, as codex's own
    // prompt would write it.
    expect(message).toContain(`[projects."${realpathSync(root)}"]`)
  })

  it('does not let a trusted mid-chain directory trust its children', () => {
    const root = tempDir()
    mkdirSync(join(root, '.git'))
    const sub = join(root, 'sub')
    const deeper = join(sub, 'deeper')
    mkdirSync(deeper, { recursive: true })
    projectConfig(sub)
    const deeperConfig = projectConfig(deeper)
    // Measured: an exact entry trusts that directory alone — inheritance flows
    // only from the git root's entry.
    const home = codexHome([{ path: sub, level: 'trusted' }])
    const message = untrustedProjectNotice({ cwd: deeper, codexHome: home })
    expect(message).toContain(deeperConfig)
    expect(message).not.toContain(join(sub, '.codex'))
  })

  it('without git: no inheritance from ancestors, and no ancestor discovery', () => {
    const root = tempDir()
    const deeper = join(root, 'sub', 'deeper')
    mkdirSync(deeper, { recursive: true })
    projectConfig(deeper)
    // Trusting the ancestor does nothing for the cwd (measured).
    const home = codexHome([{ path: root, level: 'trusted' }])
    expect(untrustedProjectNotice({ cwd: deeper, codexHome: home })).toBeDefined()
    // And an ancestor's config is never consulted from a git-less cwd, so
    // there is nothing to warn about from down here.
    const other = tempDir()
    projectConfig(other)
    const inner = join(other, 'inner')
    mkdirSync(inner)
    expect(untrustedProjectNotice({ cwd: inner, codexHome: codexHome() })).toBeUndefined()
  })

  it('matches a symlink-spelled cwd against a canonical entry, and vice versa', () => {
    const base = tempDir()
    const real = join(base, 'real')
    mkdirSync(real)
    projectConfig(real)
    const link = join(base, 'link')
    symlinkSync(real, link)
    const canonical = codexHome([{ path: realpathSync(real), level: 'trusted' }])
    expect(untrustedProjectNotice({ cwd: link, codexHome: canonical })).toBeUndefined()
    // An entry written with the symlink spelling would never match codex's
    // canonicalized cwd — but realpath'ing it can only say "trusted" for the
    // very directory it points at, so silence errs the right way.
    const spelled = codexHome([{ path: link, level: 'trusted' }])
    expect(untrustedProjectNotice({ cwd: real, codexHome: spelled })).toBeUndefined()
  })

  it('trusts a linked worktree through its main repository entry', () => {
    const base = tempDir()
    const main = join(base, 'main')
    const wt = join(base, 'wt')
    mkdirSync(main, { recursive: true })
    mkdirSync(wt, { recursive: true })
    // The linked worktree's .git is a FILE naming <main>/.git/worktrees/<name>.
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
    projectConfig(wt)
    const home = codexHome([{ path: main, level: 'trusted' }])
    expect(untrustedProjectNotice({ cwd: wt, codexHome: home })).toBeUndefined()
    expect(untrustedProjectNotice({ cwd: wt, codexHome: codexHome() })).toBeDefined()
  })

  it('stays silent when the project .codex IS the codex home, and when the cwd is missing', () => {
    const proj = tempDir()
    projectConfig(proj)
    // cwd = the directory whose .codex is CODEX_HOME itself: that config.toml
    // is the base config and always loads — nothing is being ignored.
    expect(
      untrustedProjectNotice({ cwd: proj, codexHome: join(proj, '.codex') }),
    ).toBeUndefined()
    expect(
      untrustedProjectNotice({ cwd: join(proj, 'gone'), codexHome: codexHome() }),
    ).toBeUndefined()
  })
})

describe('CodexRunner untrusted-project notice', () => {
  const stubConnectFn: AppServerConnectFn = () => ({
    request: async () => ({}),
    notify: () => {},
    onNotification: () => {},
    onRequest: () => {},
    onClose: () => {},
    close: () => {},
  })

  async function startAndCollect(config: {
    cwd: string
    codexHome?: string
    env?: Record<string, string | undefined>
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  }): Promise<SessionEvent[]> {
    const runner = new CodexRunner({ connectFn: stubConnectFn, ...config })
    const events: SessionEvent[] = []
    runner.subscribe((event) => events.push(event))
    await runner.start()
    runner.close('client')
    return events
  }

  it('emits one transcript-visible session_error for a default-mode session on an untrusted cwd', async () => {
    const proj = tempDir()
    const configPath = projectConfig(proj)
    const events = await startAndCollect({ cwd: proj, env: { CODEX_HOME: codexHome() } })
    const notices = events.filter((e) => e.type === 'session_error')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toContain(configPath)
    // The session itself is fine — the notice rides the inline-notice channel.
    expect(events.some((e) => e.type === 'status_changed' && e.status === 'idle')).toBe(true)
  })

  it('stays silent for a trusted cwd, resolving the home through the profile pin first', async () => {
    const proj = tempDir()
    projectConfig(proj)
    const trusting = codexHome([{ path: proj, level: 'trusted' }])
    // The profile's codexHome pin outranks the session env's CODEX_HOME —
    // exactly as it does in the child env the session will run under.
    const pinned = await startAndCollect({
      cwd: proj,
      codexHome: trusting,
      env: { CODEX_HOME: codexHome() },
    })
    expect(pinned.some((e) => e.type === 'session_error')).toBe(false)
    // And the same home via env alone, for symmetry.
    const viaEnv = await startAndCollect({ cwd: proj, env: { CODEX_HOME: trusting } })
    expect(viaEnv.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('stays silent in acceptEdits and bypassPermissions modes, whose thread/start self-trusts', async () => {
    const proj = tempDir()
    projectConfig(proj)
    const env = { CODEX_HOME: codexHome() }
    for (const permissionMode of ['acceptEdits', 'bypassPermissions'] as const) {
      const events = await startAndCollect({ cwd: proj, env, permissionMode })
      expect(events.some((e) => e.type === 'session_error')).toBe(false)
    }
  })
})

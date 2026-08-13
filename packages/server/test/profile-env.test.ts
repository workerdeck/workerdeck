import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeAuthStatus } from '@workerdeck/core'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

/**
 * The CLAUDE_CONFIG_DIR pin and the credential preflight, end to end. The pin
 * condition is credential-source-sensitive: setting the variable AT ALL flips
 * the CLI from its default resolution (which includes the macOS login Keychain)
 * to `<dir>/.credentials.json`, so "pin the default dir" and "don't pin" are
 * different logins, not equivalent spellings. homedir() is mocked so the tests
 * control what "~/.claude" is without touching the real home directory.
 */

let fakeHome = ''
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome }
})

function captureHarness() {
  const captured: { options?: Options } = {}
  const queryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    captured.options = params.options
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => new Promise<never>(() => {}),
      interrupt: async () => {},
      setModel: async () => {},
      close: () => {},
    } as unknown as Query
  }
  return { captured, queryFn }
}

let running: WorkerServer | undefined
const dirs: string[] = []
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  fakeHome = temp('cw-home-')
  mkdirSync(join(fakeHome, '.claude'))
  // The baseline env under test is process.env — a CLAUDE_CONFIG_DIR from the
  // developer's shell must not leak into the assertions.
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
})

afterEach(async () => {
  await running?.close()
  running = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function createSession(port: number, profile?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', ...(profile ? { profile } : {}) }),
  })
}

describe('CLAUDE_CONFIG_DIR pinning', () => {
  it('does not pin the auto-detected default profile (~/.claude)', async () => {
    const harness = captureHarness()
    running = createWorkerServer({
      allowUnauthenticated: true,
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    expect((await createSession(port)).status).toBe(201)
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    // No env at all: the SDK spawns on process.env, credential source untouched.
    expect(harness.captured.options?.env).toBeUndefined()
  })

  it('does not pin a declared profile that names ~/.claude (even unnormalized)', async () => {
    const harness = captureHarness()
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [{ name: 'me', configDir: join(fakeHome, '.claude') + '/' }],
      buildRunnerConfig: (req) => ({ ...req, env: { SOME: 'x' }, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    expect((await createSession(port, 'me')).status).toBe(201)
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(harness.captured.options?.env).toEqual({ SOME: 'x' })
  })

  it('pins a non-default dir — that is real credential isolation', async () => {
    const harness = captureHarness()
    const iso = temp('cw-iso-')
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [{ name: 'iso', configDir: iso }],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    expect((await createSession(port, 'iso')).status).toBe(201)
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(harness.captured.options?.env?.CLAUDE_CONFIG_DIR).toBe(iso)
  })

  it('still pins over a hook env that carries its own CLAUDE_CONFIG_DIR', async () => {
    const harness = captureHarness()
    const iso = temp('cw-iso-')
    const other = temp('cw-other-')
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [{ name: 'iso', configDir: iso }],
      buildRunnerConfig: (req) => ({
        ...req,
        env: { CLAUDE_CONFIG_DIR: other },
        queryFn: harness.queryFn,
      }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    expect((await createSession(port, 'iso')).status).toBe(201)
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    // The profile wins: inheriting `other` here would run the session under a
    // different identity than the profile it was created with.
    expect(harness.captured.options?.env?.CLAUDE_CONFIG_DIR).toBe(iso)
  })

  it('still pins over a CLAUDE_CONFIG_DIR in the server process env', async () => {
    const harness = captureHarness()
    const iso = temp('cw-iso-')
    vi.stubEnv('CLAUDE_CONFIG_DIR', temp('cw-other-'))
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [{ name: 'iso', configDir: iso }],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    expect((await createSession(port, 'iso')).status).toBe(201)
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(harness.captured.options?.env?.CLAUDE_CONFIG_DIR).toBe(iso)
  })

  it('leaves the env alone when it already pins the profile dir ($CLAUDE_CONFIG_DIR default)', async () => {
    const harness = captureHarness()
    const dir = temp('cw-envdir-')
    // The other auto-detect shape: the operator exported CLAUDE_CONFIG_DIR and
    // the default profile was built from it. The env already lands sessions
    // there, so nothing needs rewriting.
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir)
    running = createWorkerServer({
      allowUnauthenticated: true,
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    expect((await createSession(port)).status).toBe(201)
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(harness.captured.options?.env).toBeUndefined()
  })
})

describe('credential preflight', () => {
  it('probes each Claude profile with its session env and skips provider profiles', async () => {
    const probed: Array<Record<string, string | undefined>> = []
    const iso = temp('cw-iso-')
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [
        { name: 'iso', configDir: iso },
        { name: 'home', configDir: join(fakeHome, '.claude') },
        { name: 'kimi', engine: 'provider', provider: { id: 'moonshotai', model: 'kimi-k3' } },
      ],
      createEngineRunner: () => {
        throw new Error('not under test')
      },
      checkCredentials: {
        probe: async (env) => {
          probed.push(env)
          return 'logged_in'
        },
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await running.listen(0, '127.0.0.1')
    await vi.waitFor(() => expect(probed).toHaveLength(2))
    // The pinned profile is probed pinned; the default-dir one exactly as a
    // session would run — unpinned, so the Keychain counts.
    expect(probed[0]!.CLAUDE_CONFIG_DIR).toBe(iso)
    expect(probed[1]!.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once per logged-out profile; unknown and broken probes stay silent', async () => {
    const statuses: Record<string, ClaudeAuthStatus> = { out: 'logged_out', meh: 'unknown' }
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [
        { name: 'out', configDir: temp('cw-out-') },
        { name: 'meh', configDir: temp('cw-meh-') },
        { name: 'boom', configDir: temp('cw-boom-') },
      ],
      checkCredentials: {
        probe: async (env) => {
          const name = Object.keys(statuses).find((n) => env.CLAUDE_CONFIG_DIR?.includes(`cw-${n}-`))
          if (!name) throw new Error('probe exploded')
          return statuses[name]!
        },
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await running.listen(0, '127.0.0.1')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn.mock.calls[0]![0]).toContain("Profile 'out'")
    expect(warn.mock.calls[0]![0]).not.toContain('boom')
  })

  it('falls back to the profile pin when the host hook rejects the probe request', async () => {
    const probed: Array<Record<string, string | undefined>> = []
    const iso = temp('cw-iso-')
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [{ name: 'iso', configDir: iso }],
      buildRunnerConfig: () => {
        throw new Error('hook refuses synthetic requests')
      },
      checkCredentials: {
        probe: async (env) => {
          probed.push(env)
          return 'logged_in'
        },
      },
    })
    await running.listen(0, '127.0.0.1')
    await vi.waitFor(() => expect(probed).toHaveLength(1))
    expect(probed[0]!.CLAUDE_CONFIG_DIR).toBe(iso)
  })
})

/**
 * The probe is display-only by default, on purpose. `requireAvailableProfile` is
 * the deployment that has an end user in front of it rather than an operator:
 * there, a create that succeeds and dies mid-turn on a raw provider error is
 * worse than a refusal that says what is wrong.
 */
describe('requireAvailableProfile', () => {
  const withProbe = (
    requireAvailableProfile: boolean,
    status: ClaudeAuthStatus,
  ): WorkerServer => {
    const harness = captureHarness()
    return createWorkerServer({
      allowUnauthenticated: true,
      profiles: [{ name: 'iso', configDir: temp('cw-iso-') }],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
      requireAvailableProfile,
      checkCredentials: { probe: async () => status },
    })
  }

  it('refuses a create on a profile the probe reported unavailable', async () => {
    running = withProbe(true, 'logged_out')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { port } = await running.listen(0, '127.0.0.1')
    // The verdict lands asynchronously; before it does the profile is 'unknown'
    // and creates go through, which is the documented behaviour.
    await vi.waitFor(async () => {
      const res = await createSession(port, 'iso')
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toContain('unavailable')
    })
  })

  it("lets the same create through when the option is off — the probe can't close a door", async () => {
    running = withProbe(false, 'logged_out')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { port } = await running.listen(0, '127.0.0.1')
    // Wait for the same verdict to land — it is served, and it is still only
    // a display value.
    await vi.waitFor(async () => {
      const { profiles } = (await (await fetch(`http://127.0.0.1:${port}/v1/profiles`)).json()) as {
        profiles: Array<{ available?: boolean }>
      }
      expect(profiles[0]!.available).toBe(false)
    })
    expect((await createSession(port, 'iso')).status).toBe(201)
  })

  it("allows a profile whose probe couldn't run — unknown is not unavailable", async () => {
    running = withProbe(true, 'unknown')
    const { port } = await running.listen(0, '127.0.0.1')
    expect((await createSession(port, 'iso')).status).toBe(201)
  })
})

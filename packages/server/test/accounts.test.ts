import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectAccountResponse, ProfileInfo } from '@workerdeck/protocol'
import { createMemoryProfileStore, createWorkerServer, type WorkerServer } from '../src/index.ts'
import { ACCOUNT_FILE, accountSessionEnv, findAuthorizeUrl, screenText, writeAccount } from '../src/accounts/index.ts'
import { loadPty } from '../src/services/shell-env.ts'
import { fakeHarness } from './helpers.ts'

const FAKE_TOKEN = ['sk-ant-oat01', 'FAKE_token-123'].join('-')
const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-setup-token.mjs', import.meta.url))
const hasPty = (await loadPty()) !== null

let running: WorkerServer | undefined
const roots: string[] = []
afterEach(async () => {
  await running?.close()
  running = undefined
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wd-accounts-'))
  roots.push(root)
  const configDir = join(root, 'tobias')
  mkdirSync(configDir)
  return { root, configDir, envOut: join(root, 'env.json') }
}

async function serve(
  options: { canManage?: boolean; canConnect?: (principal: unknown, profile: ProfileInfo) => boolean; requireApiKey?: boolean } = {},
) {
  const { root: dir, configDir, envOut } = fixture()
  const harness = fakeHarness()
  const profile: ProfileInfo = { name: 'tobias', configDir }
  running = createWorkerServer({
    authenticate: () => ({ canManageProfiles: options.canManage ?? true, user: 'tobias' }),
    allowedCwdRoots: ['/tmp'],
    allowedConfigDirRoots: [dir],
    profileStore: createMemoryProfileStore([profile]),
    checkCredentials: false,
    requireApiKey: options.requireApiKey,
    buildRunnerConfig: (req) => ({
      ...req,
      queryFn: harness.queryFn,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-gateway', FAKE_ENV_OUT: envOut, WORKERDECK_AUTH_KEY: 'gw' },
    }),
    accounts: { claudeExecutable: FAKE_CLI, canConnect: options.canConnect },
  })
  const { port } = await running.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${port}/v1/profiles/tobias`
  const post = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { port, base, post, configDir, envOut, harness }
}

describe('setup-token output parsing', () => {
  it('finds the authorize URL when cursor moves stand in for spaces', () => {
    const raw = "Browser\x1b[1Cdidn't\x1b[1Copen?\x1b[2;1Hhttps://claude.ai/oauth/authorize?code=true&state=x\x1b[4;1HPaste\x1b[1Ccode"
    const text = screenText(raw)
    expect(findAuthorizeUrl(text)).toBe('https://claude.ai/oauth/authorize?code=true&state=x')
  })
})

describe('account session env', () => {
  it('injects the token, drops the gateway credentials and honours connectors: false', () => {
    const { configDir } = fixture()
    const base = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin' }
    expect(accountSessionEnv({ name: 'p', configDir }, base)).toBe(base)
    writeAccount(configDir, 'sk-ant-oat01-abc')
    const env = accountSessionEnv({ name: 'p', configDir, connectors: false }, base)
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' })
    expect(statSync(join(configDir, ACCOUNT_FILE)).mode & 0o777).toBe(0o600)
    expect(accountSessionEnv({ name: 'p', engine: 'codex', configDir }, base)).toBe(base)
  })

  it('never injects the token under requireApiKey, since a token session reports apiKeySource none', () => {
    const { configDir } = fixture()
    const base = { ANTHROPIC_API_KEY: 'k' }
    writeAccount(configDir, 'sk-ant-oat01-abc')
    expect(accountSessionEnv({ name: 'p', configDir }, base, { requireApiKey: true })).toBe(base)
  })
})

describe.skipIf(!hasPty)('account connect routes', () => {
  it('connects through the CLI, never returns the token and runs sessions on it', async () => {
    const { port, base, post, configDir, envOut, harness } = await serve()
    const started = await post('/account/connect')
    expect(started.status).toBe(200)
    const attempt = (await started.json()) as ConnectAccountResponse
    expect(attempt.authorizeUrl).toBe('https://claude.ai/oauth/authorize?code=true&client_id=fake&scope=user%3Ainference&state=abc')

    const spawned = JSON.parse(readFileSync(envOut, 'utf8')) as { args: string[]; env: Record<string, string> }
    expect(spawned.args).toEqual(['setup-token'])
    expect(spawned.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(spawned.env.WORKERDECK_AUTH_KEY).toBeUndefined()
    expect(spawned.env.CLAUDE_CONFIG_DIR).toBe(configDir)

    const done = await post('/account/complete', { attemptId: attempt.attemptId, code: 'good#abc' })
    const text = await done.text()
    expect(done.status).toBe(200)
    expect(text).not.toContain('sk-ant-oat01')
    const profile = (JSON.parse(text) as { profile: ProfileInfo }).profile
    expect(profile.account?.kind).toBe('setup-token')
    expect(JSON.parse(readFileSync(join(configDir, ACCOUNT_FILE), 'utf8')).token).toBe(FAKE_TOKEN)

    const listed = await fetch(`http://127.0.0.1:${port}/v1/profiles`).then((r) => r.text())
    expect(listed).toContain('"connectedAt"')
    expect(listed).not.toContain('sk-ant-oat01')

    const session = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', profile: 'tobias', prompt: 'hi' }),
    })
    expect(session.status).toBe(201)
    await expect.poll(() => harness.captured.options?.env).toBeDefined()
    expect(harness.captured.options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN)
    expect(harness.captured.options?.env?.ANTHROPIC_API_KEY).toBeUndefined()

    const removed = await fetch(base + '/account', { method: 'DELETE' })
    expect(((await removed.json()) as { profile: ProfileInfo }).profile.account).toBeUndefined()
    expect(() => statSync(join(configDir, ACCOUNT_FILE))).toThrow()
  })

  it('reports a rejected code and closes the attempt', async () => {
    const { post } = await serve()
    const attempt = (await (await post('/account/connect')).json()) as ConnectAccountResponse
    const rejected = await post('/account/complete', { attemptId: attempt.attemptId, code: 'wrong#abc' })
    expect(rejected.status).toBe(400)
    expect(((await rejected.json()) as { error: string }).error).toContain('not accepted')
    const again = await post('/account/complete', { attemptId: attempt.attemptId, code: 'good#abc' })
    expect(again.status).toBe(409)
  })

  it('refuses to connect under requireApiKey but still disconnects', async () => {
    const { base, post } = await serve({ requireApiKey: true })
    const refused = await post('/account/connect')
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { error: string }).error).toContain('requireApiKey')
    expect((await fetch(base + '/account', { method: 'DELETE' })).status).toBe(200)
  })

  it('refuses a principal that may not manage profiles unless canConnect says so', async () => {
    const refused = await serve({ canManage: false })
    expect((await refused.post('/account/connect')).status).toBe(403)
    await running?.close()
    running = undefined

    const allowed = await serve({ canManage: false, canConnect: (principal) => (principal as { user?: string }).user === 'tobias' })
    expect((await allowed.post('/account/connect')).status).toBe(200)
  })
})

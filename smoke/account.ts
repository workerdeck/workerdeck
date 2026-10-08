// pnpm smoke:account   - interactive: you sign in in your browser and paste the code. Mints one real setup-token on
// your account and costs one short turn on it. Revoke the token at claude.ai afterwards.
//
// The unit suite drives a fake CLI, so it shows the driver's parsing and the routes, and cannot show that the real
// `claude setup-token` hands a working token over the PTY. A green run proves: the gateway prints the real sign-in
// link; the pasted code yields a stored 0600 token that no response carries; a session on the profile answers a turn
// on that token even with a bogus ANTHROPIC_API_KEY in the gateway env (so the token wins); disconnect deletes it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { ConnectAccountResponse, ProfileInfo, SessionEvent } from '@workerdeck/protocol'
import { createMemoryProfileStore, createWorkerServer } from '@workerdeck/server'
import { ACCOUNT_FILE } from '@workerdeck/server/accounts'
import { fail, finish, note, ok, step } from './lib/report.ts'

const root = mkdtempSync(join(tmpdir(), 'wd-smoke-account-'))
const configDir = join(root, 'config')
mkdirSync(configDir)
const cwd = join(root, 'work')
mkdirSync(cwd)

function check(passed: boolean, what: string, detail?: string): void {
  if (passed) {
    ok(what, detail)
  } else {
    fail(what, detail)
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function main(): Promise<void> {
  step('private gateway with a throwaway profile')
  const server = createWorkerServer({
    authenticate: () => ({ canManageProfiles: true }),
    profileStore: createMemoryProfileStore([{ name: 'smoke', configDir }]),
    allowedConfigDirRoots: [root],
    allowedCwdRoots: [root],
    buildRunnerConfig: (req) => {
      const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: 'deliberately-invalid-gateway-key' }
      delete env.WORKERDECK_AUTH_KEY
      return { ...req, env }
    },
  })
  const { port } = await server.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${port}/v1/profiles/smoke`
  ok('gateway listening', `127.0.0.1:${port}`)

  try {
    step('connect')
    const started = await fetch(`${base}/account/connect`, { method: 'POST' })
    if (!started.ok) {
      fail('connect started', `${started.status} ${await started.text()}`)
      return
    }
    const attempt = (await started.json()) as ConnectAccountResponse
    check(/^https:\/\/[a-z.]*claude\.(ai|com)\/.*oauth\/authorize\?/.test(attempt.authorizeUrl), 'the real sign-in link came back')
    console.log(`\n  Open this link, sign in, and paste the code it shows:\n\n  ${attempt.authorizeUrl}\n`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const code = (await rl.question('  code> ')).trim()
    rl.close()

    const done = await fetch(`${base}/account/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: attempt.attemptId, code }),
    })
    const body = await done.text()
    if (!done.ok) {
      fail('code accepted', `${done.status} ${body}`)
      return
    }
    ok('code accepted')
    check(!body.includes('sk-ant-'), 'the response carries no token')
    const profile = (JSON.parse(body) as { profile: ProfileInfo }).profile
    check(profile.account?.kind === 'setup-token', 'profile.account reported', JSON.stringify(profile.account))
    const file = join(configDir, ACCOUNT_FILE)
    check((statSync(file).mode & 0o777) === 0o600, 'token file is 0600')
    check(/^sk-ant-oat01-/.test((JSON.parse(readFileSync(file, 'utf8')) as { token: string }).token), 'token file holds an oat01 token')

    step('one turn on the token, with a bogus ANTHROPIC_API_KEY in the gateway env')
    const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, profile: 'smoke', model: 'haiku', prompt: 'Reply with just: OK' }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    const runner = server.registry.get(session.id)!
    const events: SessionEvent[] = []
    runner.subscribe((event) => events.push(event))
    await waitFor(() => events.some((e) => e.type === 'turn_result' || e.type === 'session_error'), 180_000, 'the turn')
    const init = events.find((e): e is Extract<SessionEvent, { type: 'system_init' }> => e.type === 'system_init')
    note(`apiKeySource: ${init?.apiKeySource ?? 'not reported'}`)
    const result = events.find((e): e is Extract<SessionEvent, { type: 'turn_result' }> => e.type === 'turn_result')
    check(result !== undefined && result.isError !== true, 'the turn answered', result ? undefined : 'session_error')
    await runner.close?.()

    step('disconnect')
    const removed = await fetch(`${base}/account`, { method: 'DELETE' })
    check(removed.ok, 'disconnect answered')
    let gone = false
    try {
      statSync(file)
    } catch {
      gone = true
    }
    check(gone, 'token file deleted')
    note('Revoke the minted token at claude.ai > Settings > Claude Code.')
  } finally {
    await server.close()
  }
}

try {
  await main()
} catch (error) {
  fail('smoke crashed', error instanceof Error ? error.message : String(error))
} finally {
  rmSync(root, { recursive: true, force: true })
  finish()
}

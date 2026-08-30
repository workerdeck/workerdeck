import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkClaudeAuth, resolveBundledClaudeExecutable } from '../src/index.ts'

/**
 * The probe's contract is exercised against tiny shell fixtures, never the real
 * CLI — `pnpm test` spawns no Claude Code and spends no tokens. CI and dev are
 * POSIX-only (ubuntu/macOS), so `#!/bin/sh` fixtures are safe here.
 */

const dir = mkdtempSync(join(tmpdir(), 'cw-auth-probe-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const fixture = (name: string, script: string): string => {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('checkClaudeAuth', () => {
  it('reads only the loggedIn boolean from a logged-in verdict', async () => {
    const executable = fixture('logged-in.sh', `echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "x@y.z", "orgId": "123"}'`)
    await expect(checkClaudeAuth({}, { executable })).resolves.toBe('logged_in')
  })

  it('trusts the JSON over the exit code — 2.1.217 exits 1 on logged out', async () => {
    const executable = fixture('logged-out.sh', `echo '{"loggedIn": false, "authMethod": "none"}'\nexit 1`)
    await expect(checkClaudeAuth({}, { executable })).resolves.toBe('logged_out')
  })

  it('forwards the caller env to the CLI', async () => {
    // Verdict keyed off an env var: proves the probe runs on the exact env the
    // session would get, which is the whole point of probing per profile.
    const executable = fixture(
      'env-keyed.sh',
      `if [ -n "$CW_TEST_CREDS" ]; then echo '{"loggedIn": true}'; else echo '{"loggedIn": false}'; fi`,
    )
    await expect(checkClaudeAuth({ CW_TEST_CREDS: '1' }, { executable })).resolves.toBe('logged_in')
    await expect(checkClaudeAuth({}, { executable })).resolves.toBe('logged_out')
  })

  it("is 'unknown' for output that is not this CLI's contract", async () => {
    const garbage = fixture('garbage.sh', `echo 'Usage: claude [options]'\nexit 2`)
    await expect(checkClaudeAuth({}, { executable: garbage })).resolves.toBe('unknown')
    // parseable JSON, but no loggedIn boolean — a future shape, not a logout
    const reshaped = fixture('reshaped.sh', `echo '{"status": "ok"}'`)
    await expect(checkClaudeAuth({}, { executable: reshaped })).resolves.toBe('unknown')
  })

  it("is 'unknown' when the executable cannot be spawned", async () => {
    await expect(checkClaudeAuth({}, { executable: join(dir, 'no-such-binary') })).resolves.toBe('unknown')
  })

  it("is 'unknown' when the CLI hangs past the timeout", async () => {
    const executable = fixture('hang.sh', `sleep 30`)
    await expect(checkClaudeAuth({}, { executable, timeoutMs: 200 })).resolves.toBe('unknown')
  })
})

describe('resolveBundledClaudeExecutable', () => {
  it("finds the SDK's own platform binary in this workspace", () => {
    // The SDK is a real dependency of core, so its platform package is always
    // installed here — the resolver must find the same binary query() spawns.
    const path = resolveBundledClaudeExecutable()
    expect(path).toBeDefined()
    expect(path).toMatch(/claude-agent-sdk-.*[/\\]claude(\.exe)?$/)
  })
})

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkClaudeAuth, resolveBundledClaudeExecutable } from '../src/index.ts'
import { claudeAuthVerdict } from '../src/engines/claude/auth.ts'

const dir = mkdtempSync(join(tmpdir(), 'cw-auth-probe-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// One executable for every case: macOS vets each newly written executable on its first exec, ~400 ms apiece.
const executable = join(dir, 'claude')
writeFileSync(
  executable,
  `#!/bin/sh
[ "$1 $2" = "auth status" ] || exit 64
case "$CW_FIXTURE" in
  logged-in) echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "x@y.z", "orgId": "123"}' ;;
  logged-out) echo '{"loggedIn": false, "authMethod": "none"}'; exit 1 ;;
  hang) sleep 30 ;;
  *) if [ -n "$CW_TEST_CREDS" ]; then echo '{"loggedIn": true}'; else echo '{"loggedIn": false}'; fi ;;
esac
`,
)
chmodSync(executable, 0o755)

describe('checkClaudeAuth', () => {
  it('reads only the loggedIn boolean from a logged-in verdict', async () => {
    await expect(checkClaudeAuth({ CW_FIXTURE: 'logged-in' }, { executable })).resolves.toBe('logged_in')
  })

  it('trusts the JSON over the exit code - 2.1.217 exits 1 on logged out', async () => {
    await expect(checkClaudeAuth({ CW_FIXTURE: 'logged-out' }, { executable })).resolves.toBe('logged_out')
  })

  it('forwards the caller env to the CLI', async () => {
    await expect(checkClaudeAuth({ CW_TEST_CREDS: '1' }, { executable })).resolves.toBe('logged_in')
    await expect(checkClaudeAuth({}, { executable })).resolves.toBe('logged_out')
  })

  it("is 'unknown' for output that is not this CLI's contract", () => {
    expect(claudeAuthVerdict('Usage: claude [options]\n')).toBe('unknown')
    expect(claudeAuthVerdict('')).toBe('unknown')
    // parseable JSON, but no loggedIn boolean - a future shape, not a logout
    expect(claudeAuthVerdict('{"status": "ok"}\n')).toBe('unknown')
    expect(claudeAuthVerdict('{"loggedIn": "false"}')).toBe('unknown')
    expect(claudeAuthVerdict('null')).toBe('unknown')
  })

  it("is 'unknown' when the executable cannot be spawned", async () => {
    await expect(checkClaudeAuth({}, { executable: join(dir, 'no-such-binary') })).resolves.toBe('unknown')
  })

  it("is 'unknown' when the CLI hangs past the timeout", async () => {
    await expect(checkClaudeAuth({ CW_FIXTURE: 'hang' }, { executable, timeoutMs: 50 })).resolves.toBe('unknown')
  })
})

describe('resolveBundledClaudeExecutable', () => {
  it("finds the SDK's own platform binary in this workspace", () => {
    const path = resolveBundledClaudeExecutable()
    expect(path).toBeDefined()
    expect(path).toMatch(/claude-agent-sdk-.*[/\\]claude(\.exe)?$/)
  })
})

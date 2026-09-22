import { describe, expect, it } from 'vitest'
import type { ShellItem } from '@workerdeck/react'
import type { ShellInfo } from '@workerdeck/protocol'
import { buildMarks } from '../src/components/agent/scrubber-marks.ts'
import {
  SHELL_MISSING,
  shellBodyLines,
  shellFailed,
  shellFooterText,
  shellHeaderText,
  shellLabel,
  shellStatusText,
} from '../src/components/terminal/shell-row.ts'

function shell(overrides: Partial<ShellInfo> = {}): ShellInfo {
  return {
    id: 'sh_abc',
    sessionId: 's1',
    ordinal: 3,
    command: 'npm run dev',
    label: 'npm run dev',
    cwd: '/tmp/p',
    owner: 'user',
    status: 'running',
    startedAt: 1000,
    bytes: 4,
    cols: 120,
    rows: 40,
    ...overrides,
  }
}

function item(overrides: Partial<ShellItem> = {}): ShellItem {
  return { kind: 'shell', id: 'row-1', shell: shell(), text: 'one\ntwo', truncated: false, ...overrides }
}

describe('the shell row', () => {
  it('names a running shell and offers the kill glyph', () => {
    expect(shellHeaderText(item())).toBe('npm run dev · running ✕')
    expect(shellStatusText(item())).toBe('running')
    expect(shellFailed(item())).toBe(false)
  })

  it('reads a non-zero exit as a failure and a restart honestly', () => {
    const failed = item({ shell: shell({ status: 'exited', exitCode: 1, endedAt: 2000, endReason: 'exit' }) })
    expect(shellStatusText(failed)).toBe('exit 1')
    expect(shellFailed(failed)).toBe(true)
    const restarted = item({ shell: shell({ status: 'exited', endedAt: 2000, endReason: 'server_restarted' }) })
    expect(shellStatusText(restarted)).toContain('may still be running')
  })

  it('falls back to the command when the record carries no label', () => {
    expect(shellLabel(item({ shell: shell({ label: '', command: 'ls -la\nsecond line' }) }))).toBe('ls -la')
  })

  it('shows the inline lines collapsed and the fetched view expanded', () => {
    const truncated = item({ truncated: true, expanded: 'one\ntwo\nthree' })
    expect(shellBodyLines(truncated, false)).toEqual(['one', 'two'])
    expect(shellBodyLines(truncated, true)).toEqual(['one', 'two', 'three'])
  })

  it('offers the fetch only while there is more, and says so when the record is gone', () => {
    expect(shellFooterText(item(), false, 2)).toBeUndefined()
    expect(shellFooterText(item({ truncated: true }), false, 2)).toContain('expand')
    expect(shellFooterText(item({ missing: true }), false, 2)).toBe(SHELL_MISSING)
  })

  it('marks a shell row in the input lane', () => {
    const marks = buildMarks([item()])
    expect(marks.map((mark) => mark.kind)).toEqual(['shell'])
  })
})

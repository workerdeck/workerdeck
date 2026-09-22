import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventBody, ShellInfo } from '@workerdeck/protocol'
import {
  applyEvent,
  hydrateShellOutput,
  hydrateShellRow,
  initialTranscriptState,
  shellRowText,
  type ShellItem,
  type TranscriptState,
} from '../src/lib/transcript.ts'

let seq = 0
function ev(body: SessionEventBody): SessionEvent {
  return { ...body, seq: ++seq, ts: 0 }
}

function shell(overrides: Partial<ShellInfo> = {}): ShellInfo {
  return {
    id: 'sh_abc',
    sessionId: 's1',
    ordinal: 3,
    command: 'npm test',
    label: 'npm test',
    cwd: '/tmp/p',
    owner: 'user',
    status: 'running',
    startedAt: 1000,
    bytes: 12,
    cols: 120,
    rows: 40,
    ...overrides,
  }
}

function row(state: TranscriptState): ShellItem {
  const item = state.items.find((candidate): candidate is ShellItem => candidate.kind === 'shell')
  expect(item).toBeDefined()
  return item!
}

function emit(state: TranscriptState, info: ShellInfo, text: string, uuid = 'row-1'): TranscriptState {
  return applyEvent(
    state,
    ev({ type: 'user_message', message: { role: 'user', content: text }, parentToolUseId: null, synthetic: true, uuid, shell: info }),
  )
}

describe('the shell transcript row', () => {
  it('strips the command line, the omission marker and the end line', () => {
    const parsed = shellRowText(
      shell({ status: 'exited', exitCode: 1, endReason: 'exit', endedAt: 2000 }),
      '<local-command-stderr>$ npm test\nfail one\nfail two [...]\n[... more output ...]\n[exit 1]</local-command-stderr>',
    )
    expect(parsed).toEqual({ text: 'fail one\nfail two [...]', truncated: true })
  })

  it('keeps a running row untruncated when nothing was omitted', () => {
    const parsed = shellRowText(shell(), '<local-command-stdout>$ npm run dev\nready</local-command-stdout>')
    expect(parsed).toEqual({ text: 'ready', truncated: false })
  })

  it('produces one shell item and upserts the second emission in place', () => {
    seq = 0
    const running = emit(initialTranscriptState, shell(), '<local-command-stdout>$ npm test\nrunning…</local-command-stdout>')
    expect(running.items).toHaveLength(1)
    expect(row(running).shell.status).toBe('running')

    const exited = emit(
      running,
      shell({ status: 'exited', exitCode: 0, endReason: 'exit', endedAt: 2000 }),
      '<local-command-stdout>$ npm test\nall good</local-command-stdout>',
    )
    expect(exited.items).toHaveLength(1)
    expect(row(exited).shell.status).toBe('exited')
    expect(row(exited).text).toBe('all good')
  })

  it('carries an expanded row across the re-emit', () => {
    seq = 0
    const first = emit(initialTranscriptState, shell(), '<local-command-stdout>$ npm test\none</local-command-stdout>')
    const loaded = hydrateShellOutput(first, 'sh_abc', 'one\ntwo\nthree')
    const again = emit(loaded, shell({ bytes: 30 }), '<local-command-stdout>$ npm test\none\ntwo</local-command-stdout>')
    expect(row(again).expanded).toBe('one\ntwo\nthree')
  })

  it('falls back to a notice when the event carries no shell', () => {
    seq = 0
    const state = applyEvent(
      initialTranscriptState,
      ev({
        type: 'user_message',
        message: { role: 'user', content: '<local-command-stdout>$ ls\nREADME.md</local-command-stdout>' },
        parentToolUseId: null,
        synthetic: true,
        uuid: 'row-2',
      }),
    )
    expect(state.items.map((item) => item.kind)).toEqual(['notice'])
  })

  it('marks the row missing when the record is gone', () => {
    seq = 0
    const state = emit(initialTranscriptState, shell(), '<local-command-stdout>$ npm test\none</local-command-stdout>')
    expect(row(hydrateShellRow(state, 'sh_abc', undefined)).missing).toBe(true)
  })

  it('hydrates the record a running row verifies itself against', () => {
    seq = 0
    const state = emit(initialTranscriptState, shell(), '<local-command-stdout>$ npm test\none</local-command-stdout>')
    const verified = hydrateShellRow(state, 'sh_abc', shell({ status: 'exited', endReason: 'server_restarted', endedAt: 3000 }))
    expect(row(verified).shell.endReason).toBe('server_restarted')
    expect(row(verified).text).toBe('one')
  })
})

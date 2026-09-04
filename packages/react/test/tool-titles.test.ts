import { describe, expect, it } from 'vitest'
import { TOOL_TITLE_MAX_CHARS, sanitizeToolTitle, toolTitle } from '@workerdeck/protocol'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, type TranscriptState } from '../src/lib/transcript.ts'

let seq = 0
function ev(body: SessionEventBody): SessionEvent {
  return { ...body, seq: ++seq, ts: 0 }
}

function run(state: TranscriptState, bodies: SessionEventBody[]): TranscriptState {
  return bodies.reduce((s, body) => applyEvent(s, ev(body)), state)
}

describe('tool titles', () => {
  it('prefers a declared title, falls back to the built-in table, then to the wire name', () => {
    const titles = { knowledge_upload: 'Uploading knowledge' }
    expect(toolTitle('knowledge_upload', titles)).toBe('Uploading knowledge')
    expect(toolTitle('eval_script', titles)).toBe('Running a script')
    expect(toolTitle('atomic__AppContext', titles)).toBeUndefined()
  })

  it('never invents a title from the wire name', () => {
    expect(toolTitle('atomic__AppContext')).toBeUndefined()
    expect(toolTitle('Bash')).toBeUndefined()
  })

  it('flattens and clamps a server-supplied title, because it is untrusted display text', () => {
    expect(sanitizeToolTitle('Reading\nthe\tcurrent page')).toBe('Reading the current page')
    expect(sanitizeToolTitle('Deleting leads')).toBe('Deleting leads')
    expect(sanitizeToolTitle('  ')).toBeUndefined()
    const long = sanitizeToolTitle('x'.repeat(200))
    expect(long).toHaveLength(TOOL_TITLE_MAX_CHARS)
    expect(long?.endsWith('…')).toBe(true)
  })

  it('drops a title that only restates the wire name', () => {
    expect(sanitizeToolTitle('fs_write', 'fs_write')).toBeUndefined()
  })

  it('merges every tool_titles event into transcript state', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      { type: 'tool_titles', titles: { knowledge_upload: 'Uploading knowledge' } },
      { type: 'tool_titles', titles: { atomic__AppContext: 'Reading the current page' } },
    ])
    expect(state.toolTitles).toEqual({
      knowledge_upload: 'Uploading knowledge',
      atomic__AppContext: 'Reading the current page',
    })
  })
})

import { describe, expect, it } from 'vitest'
import { readStatusLabelInput, type StatusLabel, type StatusLabelInput } from '@workerdeck/protocol'
import { EventLog } from '../src/lib/event-log.ts'
import { runSessionTool, sessionToolSpecs } from '../src/lib/session-tools.ts'

function label(text: string): StatusLabel {
  return { text, setAt: 1 }
}

describe('status label in the event log', () => {
  it('is unknown until set, follows each set, and clears on a conversation reset', () => {
    const log = new EventLog()
    expect(log.statusLabel).toBeUndefined()
    log.append({ type: 'status_label', label: label('waiting on CI') })
    expect(log.statusLabel).toEqual(label('waiting on CI'))
    log.append({ type: 'status_label', label: null })
    expect(log.statusLabel).toBeNull()
    log.append({ type: 'status_label', label: label('reviewing') })
    log.append({ type: 'conversation_reset' })
    expect(log.statusLabel).toBeNull()
  })

  it('is refolded from a restored log', () => {
    const source = new EventLog()
    source.append({ type: 'status_label', label: label('blocked') })
    const restored = new EventLog()
    restored.restore(source.events, source.seq, undefined)
    expect(restored.statusLabel).toEqual(label('blocked'))
  })
})

describe('set_status', () => {
  const rig = () => {
    const calls: (StatusLabelInput | null)[] = []
    const sources = {
      write: false,
      status: (input: StatusLabelInput | null) => {
        calls.push(input)
        return input ? { ...input, setAt: 1 } : null
      },
    }
    return { calls, sources }
  }

  it('is offered with the other gateway tools', () => {
    expect(sessionToolSpecs(rig().sources).map((spec) => spec.name)).toContain('set_status')
  })

  it('sets a trimmed line, and clears on an empty text', async () => {
    const { calls, sources } = rig()
    expect(await runSessionTool(sources, 's', 'set_status', { text: '  waiting   on CI ', emoji: ' ⏳ ' })).toEqual({
      text: 'Status set: ⏳ waiting on CI',
      isError: false,
    })
    expect(await runSessionTool(sources, 's', 'set_status', { text: '' })).toEqual({ text: 'Status cleared', isError: false })
    expect(calls).toEqual([{ text: 'waiting on CI', emoji: '⏳' }, null])
  })

  it('refuses a line over the cap without calling the sink', async () => {
    const { calls, sources } = rig()
    const out = await runSessionTool(sources, 's', 'set_status', { text: 'x'.repeat(81) })
    expect(out?.isError).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('readStatusLabelInput', () => {
  it('reads, trims, clears and refuses', () => {
    expect(readStatusLabelInput({ text: ' done ' })).toEqual({ text: 'done' })
    expect(readStatusLabelInput({ text: '   ' })).toBeNull()
    expect(readStatusLabelInput(null)).toBeNull()
    expect(readStatusLabelInput({ text: 3 })).toBe('statusLabel.text must be a string')
    expect(readStatusLabelInput({ text: 'x'.repeat(81) })).toMatch(/longer than 80/)
  })
})

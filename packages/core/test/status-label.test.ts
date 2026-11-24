import { describe, expect, it } from 'vitest'
import { agentStatusRefusal, readStatusLabelInput, type StatusLabel, type StatusLabelInput } from '@workerdeck/protocol'
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
    expect(await runSessionTool(sources, 's', 'set_status', { text: '  Waiting   on CI ' })).toEqual({
      text: 'Status set: Waiting on CI',
      isError: false,
    })
    expect(await runSessionTool(sources, 's', 'set_status', { text: '' })).toEqual({ text: 'Status cleared', isError: false })
    expect(calls).toEqual([{ text: 'Waiting on CI' }, null])
  })

  it('refuses more than three words or an emoji, teaching the format, without calling the sink', async () => {
    const { calls, sources } = rig()
    const long = await runSessionTool(sources, 's', 'set_status', { text: 'reviewing the auth diff now' })
    expect(long).toMatchObject({ isError: true, text: expect.stringMatching(/5 words, at most 3.*Verb Noun.*"Running Tests"/) })
    const emoji = await runSessionTool(sources, 's', 'set_status', { text: '⏳ Waiting' })
    expect(emoji).toMatchObject({ isError: true, text: expect.stringMatching(/no emoji/) })
    expect(calls).toEqual([])
  })

  it('forwards waitingOn, and refuses any value other than human', async () => {
    const { calls, sources } = rig()
    expect(await runSessionTool(sources, 's', 'set_status', { text: 'Needs API Key', waitingOn: 'human' })).toEqual({
      text: 'Status set: Needs API Key (waiting on the human)',
      isError: false,
    })
    expect((await runSessionTool(sources, 's', 'set_status', { text: 'x', waitingOn: 'lead' }))?.isError).toBe(true)
    expect(calls).toEqual([{ text: 'Needs API Key', waitingOn: 'human' }])
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
    expect(readStatusLabelInput({ text: ' blocked ', waitingOn: 'human' })).toEqual({ text: 'blocked', waitingOn: 'human' })
    expect(readStatusLabelInput({ text: '', waitingOn: 'human' })).toBeNull()
    expect(readStatusLabelInput({ text: 'x', waitingOn: 'lead' })).toBe("statusLabel.waitingOn must be 'human'")
  })
})

describe('agentStatusRefusal', () => {
  it('allows Verb Noun up to three words, refuses more and any emoji', () => {
    expect(agentStatusRefusal('Running Tests')).toBeUndefined()
    expect(agentStatusRefusal(' Needs  Relay Key ')).toBeUndefined()
    expect(agentStatusRefusal('')).toBeUndefined()
    expect(agentStatusRefusal('Waiting on CI #412')).toBe('4 words, at most 3')
    expect(agentStatusRefusal('Done 🎉')).toBe('no emoji')
  })
})

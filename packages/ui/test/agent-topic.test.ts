import { describe, expect, it } from 'vitest'
import { agentTopic } from '../src/components/agent/SessionItem.tsx'

describe('agentTopic', () => {
  it('drops a title that only repeats the agent name', () => {
    expect(agentTopic({ title: 'AC-Lead', agent: { id: 'a', name: 'AC-Lead' } })).toBeUndefined()
    expect(agentTopic({ title: ' ac-lead ', agent: { id: 'a', name: 'AC-Lead' } })).toBeUndefined()
  })

  it('keeps a real topic', () => {
    expect(agentTopic({ title: 'Relay follow-ups', agent: { id: 'a', name: 'Marlow' } })).toBe('Relay follow-ups')
    expect(agentTopic({ title: undefined, agent: { id: 'a', name: 'Marlow' } })).toBeUndefined()
  })
})

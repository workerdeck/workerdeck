import { describe, expect, it } from 'vitest'
import { newAgentOwner, newAgentSharing, type ProfileInfo } from '@workerdeck/protocol'

describe('new agent defaults', () => {
  const toby: ProfileInfo = { name: 'toby', owner: 'tobias', defaults: { sharing: 'private' } }
  const plain: ProfileInfo = { name: 'claude' }

  it('takes the profile owner over the gateway default owner', () => {
    expect(newAgentOwner({ owner: 'silkweave', sharing: 'shared', allowShared: true }, toby)).toBe('tobias')
    expect(newAgentOwner({ owner: 'silkweave', sharing: 'shared', allowShared: true }, plain)).toBe('silkweave')
    expect(newAgentOwner(undefined, plain)).toBeUndefined()
  })

  it('resolves sharing in the order the gateway applies it, and never shared where sharing is off', () => {
    expect(newAgentSharing({ sharing: 'shared', allowShared: true }, toby)).toBe('private')
    expect(newAgentSharing({ sharing: 'shared', allowShared: true }, plain)).toBe('shared')
    expect(newAgentSharing({ sharing: 'private', allowShared: true }, { name: 'sw', defaults: { sharing: 'shared' } })).toBe('shared')
    expect(newAgentSharing({ sharing: 'private', allowShared: false }, { name: 'sw', defaults: { sharing: 'shared' } })).toBe('private')
    expect(newAgentSharing(undefined, undefined)).toBe('private')
  })
})

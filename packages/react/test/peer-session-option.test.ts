import { describe, expect, it } from 'vitest'
import { peerSessionOption } from '../src/hooks/use-peer-sessions.ts'

describe('peerSessionOption', () => {
  it('offers an agent under its name, ahead of the session title', () => {
    expect(
      peerSessionOption({ id: 'e569f467-a88b', status: 'idle', cwd: '/w', pendingPermissionCount: 0, agent: 'WD-Lead' }),
    ).toMatchObject({ slug: 'WD-Lead', label: 'WD-Lead' })
    expect(
      peerSessionOption({ id: 'c', status: 'idle', cwd: '/w', pendingPermissionCount: 0, agent: 'Astra', title: 'Fix login bug' }),
    ).toMatchObject({ slug: 'Astra', label: 'Astra' })
  })

  it('falls back to the title, then the short id', () => {
    expect(peerSessionOption({ id: 'b', status: 'idle', cwd: '/w', pendingPermissionCount: 0, title: 'Fix login bug' })).toMatchObject({
      slug: 'Fix-login-bug',
      label: 'Fix login bug',
    })
    expect(peerSessionOption({ id: 'e569f467-a88b', status: 'idle', cwd: '/w', pendingPermissionCount: 0 })).toMatchObject({
      slug: 'e569f467',
      label: 'e569f467',
    })
  })
})

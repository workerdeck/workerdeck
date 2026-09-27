import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@workerdeck/protocol'
import { permissionPromptModel } from '../src/lib/permission-prompt.ts'

function request(extra: Partial<PermissionRequest> = {}): PermissionRequest {
  return { id: 'p1', toolName: 'Read', input: { file_path: '/tmp/a.txt' }, toolUseId: 't1', ...extra }
}

describe('permissionPromptModel', () => {
  it('heads with the SDK title, the full prompt sentence, over the compact displayName', () => {
    const model = permissionPromptModel(request({ title: 'Claude wants to read a.txt', displayName: 'Read file' }))
    expect(model.heading).toBe('Claude wants to read a.txt')
    expect(model.question).toBe('Do you want to proceed?')
  })

  it('falls back to displayName, then to a generic heading', () => {
    expect(permissionPromptModel(request({ displayName: 'Read file' })).heading).toBe('Read file')
    expect(permissionPromptModel(request()).heading).toBe('Permission needed')
  })

  it('carries description and decision reason through untouched', () => {
    const model = permissionPromptModel(request({ description: 'read access to /tmp', decisionReason: 'not in allow list' }))
    expect(model.description).toBe('read access to /tmp')
    expect(model.decisionReason).toBe('not in allow list')
  })

  it('turns an ExitPlanMode request into the plan review', () => {
    const model = permissionPromptModel(request({ toolName: 'ExitPlanMode', input: { plan: '## Plan' }, title: 'ignored' }))
    expect(model.plan).toBe('## Plan')
    expect(model.shell).toBeUndefined()
    expect(model.heading).toBe('Plan ready for review')
    expect(model.choices.map((c) => c.button)).toEqual(['Approve plan', 'Keep planning', 'Stop the turn'])
    expect(model.denyPlaceholder).toContain('keeps planning')
  })

  it('offers allow, deny and stop in that order, with stop the only danger', () => {
    const { choices } = permissionPromptModel(request())
    expect(choices.map((c) => c.key)).toEqual(['allow', 'deny', 'stop'])
    expect(choices.map((c) => c.button)).toEqual(['Allow', 'Deny', 'Deny & stop'])
    expect(choices.map((c) => c.option)).toEqual(['Yes', 'No, and tell the agent what to do differently', 'No, and stop the turn'])
    expect(choices.filter((c) => c.danger).map((c) => c.key)).toEqual(['stop'])
  })
})

import { describe, expect, it } from 'vitest'
import { planFromRequest } from '../src/lib/plan-request.ts'

describe('planFromRequest', () => {
  it('extracts the plan markdown from an ExitPlanMode request', () => {
    const plan = '## Plan\n\n1. Do the thing\n2. Verify it'
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: { plan } })).toBe(plan)
  })

  it('ignores every other tool, even one whose input carries a plan field', () => {
    expect(planFromRequest({ toolName: 'Bash', input: { plan: '## Plan' } })).toBeUndefined()
    expect(planFromRequest({ toolName: 'exitplanmode', input: { plan: '## Plan' } })).toBeUndefined()
    expect(planFromRequest({ toolName: 'mcp__x__ExitPlanMode', input: { plan: '## Plan' } })).toBeUndefined()
  })

  it('falls back to generic rendering when the plan is missing or not a string', () => {
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: {} })).toBeUndefined()
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: { plan: 42 } })).toBeUndefined()
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: { plan: null } })).toBeUndefined()
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: { plan: ['a'] } })).toBeUndefined()
  })

  it('treats a blank plan as absent', () => {
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: { plan: '' } })).toBeUndefined()
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: { plan: '  \n\t' } })).toBeUndefined()
  })

  it('survives a malformed request shape', () => {
    expect(planFromRequest(undefined)).toBeUndefined()
    expect(planFromRequest(null)).toBeUndefined()
    expect(planFromRequest({ toolName: 'ExitPlanMode' })).toBeUndefined()
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: null })).toBeUndefined()
    expect(planFromRequest({ toolName: 'ExitPlanMode', input: 'plan' })).toBeUndefined()
  })
})

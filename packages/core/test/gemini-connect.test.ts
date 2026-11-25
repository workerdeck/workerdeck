import { describe, expect, it } from 'vitest'
import { geminiChildEnv } from '../src/engines/gemini/connect.ts'

describe('geminiChildEnv', () => {
  it('signs a cloud profile in through ADC on its project, dropping inherited keys and cloud settings', () => {
    const base = { PATH: '/bin', GEMINI_API_KEY: 'inherited', GOOGLE_CLOUD_PROJECT: 'someone-else', AGY_ADC_AUTH: '0' }
    const { env, auth } = geminiChildEnv(base, undefined, { project: 'workerdeck' })
    expect(auth).toEqual({ methodId: 'agent-platform' })
    expect(env).toMatchObject({ PATH: '/bin', AGY_ADC_AUTH: '1', GOOGLE_CLOUD_PROJECT: 'workerdeck', GOOGLE_CLOUD_LOCATION: 'global' })
    expect(env.GEMINI_API_KEY).toBeUndefined()
  })

  it('keeps an inherited cloud project out of a profile without one', () => {
    const { env, auth } = geminiChildEnv({ PATH: '/bin', GOOGLE_CLOUD_PROJECT: 'someone-else', AGY_ADC_AUTH: '1' })
    expect(auth).toEqual({ methodId: null })
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined()
    expect(env.AGY_ADC_AUTH).toBeUndefined()
  })
})

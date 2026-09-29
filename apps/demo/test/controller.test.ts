import { describe, expect, it } from 'vitest'

import { beat, say, turnEnd } from '../src/stage/tape.ts'
import { TourController } from '../src/tour/controller.ts'
import type { Journey, Scene } from '../src/tour/types.ts'

function scene(): Scene {
  return { seeds: [{ info: { id: 's1', cwd: '/tmp/p' } }] }
}

const JOURNEY: Journey = {
  id: 'test',
  title: 'Test',
  summary: 'test',
  regions: [],
  scene,
  async run(d) {
    await d.explain({ title: 'one', body: '' })
    await d.hint('s1', 'do it')
    await d.play('s1', beat(500, say('done'), turnEnd()))
    await d.explain({ title: 'two', body: '' })
  },
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('TourController', () => {
  it('counts checkpoints with a dry run', async () => {
    const controller = new TourController({ home: scene })
    controller.start(JOURNEY)
    await settle()
    expect(controller.state.total).toBe(3)
    expect(controller.state.card?.title).toBe('one')
  })

  it('a hint sends its prompt as a user message', async () => {
    const controller = new TourController({ home: scene, speed: Number.POSITIVE_INFINITY })
    controller.start(JOURNEY)
    await settle()
    controller.next()
    await settle()
    expect(controller.state.hint).toEqual({ sessionId: 's1', prompt: 'do it' })
    controller.next()
    await settle()
    expect(controller.gateway.session('s1').activityCount).toBe(1)
  })

  it('back fast-forwards a fresh gateway to the previous checkpoint', async () => {
    const controller = new TourController({ home: scene, speed: Number.POSITIVE_INFINITY })
    controller.start(JOURNEY)
    await settle()
    controller.next()
    await settle()
    controller.next()
    await until(() => controller.state.card?.title === 'two')
    expect(controller.state.card?.title).toBe('two')
    const before = controller.gateway
    controller.back()
    await until(() => controller.gateway !== before && controller.state.hint?.prompt === 'do it')
    expect(controller.gateway).not.toBe(before)
    expect(controller.state.checkpoint).toBe(1)
    expect(controller.state.hint?.prompt).toBe('do it')
    expect(controller.gateway.session('s1').proseCount).toBe(0)
  })
})

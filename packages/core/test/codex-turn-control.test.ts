import { describe, expect, it, vi } from 'vitest'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { GRANULAR_NEVER, collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

describe('CodexRunner: interrupt, resume, child death and mode changes', () => {
  it('interrupts via turn/interrupt and lands as an interrupted turn result', async () => {
    const peer = scriptedPeer()
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-9', status: 'inProgress' } })
      return { turn: { id: 'turn-9', status: 'inProgress' } }
    })
    peer.respond('turn/interrupt', () => {
      peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-9', status: 'interrupted' } })
      return {}
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'spin', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(runner.status).toBe('running'))
    await runner.interrupt()
    await run
    expect(peer.requests.find((r) => r.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-9',
    })
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['interrupted'],
    })
    expect(runner.status).toBe('idle')
  })

  it('resumes: a create-request resume goes through thread/resume, and a dead child respawns into the same thread', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'a1', type: 'agentMessage', text: 'back' },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'continue',
      resume: 'prior-thread',
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()
    expect(peer.requests[2]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'prior-thread' },
      connection: 1,
    })
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'success', result: 'back' })

    peer.die('codex app-server exited (code 1): boom')
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
    const resumed = peer.requests.filter((r) => r.method === 'thread/resume')
    expect(resumed).toHaveLength(2)
    expect(resumed[1]).toMatchObject({ params: { threadId: 'thread-1' }, connection: 2 })
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ subtype: 'success' })
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('fails the in-flight turn with the exit diagnostic when the child dies mid-turn', async () => {
    const peer = scriptedPeer()
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 't', status: 'inProgress' } })
      return { turn: { id: 't', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(runner.status).toBe('running'))
    peer.die('codex app-server exited (SIGKILL): stderr tail here')
    await run
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['codex app-server exited (SIGKILL): stderr tail here'],
    })
    expect(runner.status).toBe('idle')
  })

  it('treats a failed turn as a failed turn — turn/completed(status failed) with its error', async () => {
    const peer = scriptedPeer()
    peer.respond('turn/start', () => {
      peer.emit('error', {
        threadId: 'thread-1',
        turnId: 't',
        error: { message: 'Reconnecting… 1/5' },
        willRetry: true,
      })
      peer.emit('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 't', status: 'failed', error: { message: '401 Unauthorized' } },
      })
      return { turn: { id: 't', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['401 Unauthorized'],
    })
    expect(runner.status).toBe('idle')
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('namespaces item ids per turn — one long-lived child never publishes colliding ids', async () => {
    const peer = scriptedPeer()
    const answer = (text: string) => (emit: (m: string, p: unknown) => void, turnId: string) => {
      emit('item/started', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item_0', type: 'commandExecution', command: 'ls', status: 'inProgress' },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'item_0',
          type: 'commandExecution',
          command: 'ls',
          aggregatedOutput: 'ok\n',
          exitCode: 0,
          status: 'completed',
        },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item_1', type: 'agentMessage', text },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    }
    let turnIndex = 0
    peer.respond('turn/start', () => {
      const turnId = `turn-${++turnIndex}`
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } })
      answer(turnIndex === 1 ? 'four' : 'six')(peer.emit, turnId)
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    runner.sendMessage('2+2')
    runner.sendMessage('3+3')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))

    const answers = ofType(events, 'assistant_message').filter(
      (e) => Array.isArray(e.message.content) && e.message.content[0]!.type === 'text',
    )
    expect(answers.map((e) => (e.message.content as Array<{ text: string }>)[0]!.text)).toEqual(['four', 'six'])
    expect(answers[0]!.uuid).not.toBe(answers[1]!.uuid)
    for (const a of answers) {
      expect(a.uuid).toMatch(/:item_1$/)
    }

    const uses = ofType(events, 'assistant_message')
      .map((e) => (e.message.content as Array<{ type: string; id?: string }>)[0]!)
      .filter((block) => block.type === 'tool_use')
    expect(uses).toHaveLength(2)
    expect(uses[0]!.id).not.toBe(uses[1]!.id)
    const resultIds = ofType(events, 'user_message')
      .filter((e) => e.synthetic)
      .map((e) => (e.message.content as Array<{ tool_use_id: string }>)[0]!.tool_use_id)
    expect(resultIds).toEqual([uses[0]!.id, uses[1]!.id])
  })

  it('applies model/mode between turns, resets to the resolved default, refuses mid-turn', async () => {
    const peer = scriptedPeer()
    let turnIndex = 0
    peer.respond('turn/start', () => {
      const turnId = `turn-${++turnIndex}`
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } })
      if (turnIndex < 3) {
        peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
      } // turn 3 hangs for the mid-turn refusals
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    await runner.start()
    const turnParams = () => peer.requests.filter((r) => r.method === 'turn/start')
    expect(turnParams()[0]!.params).toMatchObject({
      model: 'gpt-5.6-terra',
      effort: 'medium',
      sandboxPolicy: { type: 'readOnly' },
    })

    await runner.setModel('gpt-5.5')
    await runner.setPermissionMode('bypassPermissions')
    runner.sendMessage('next')
    await vi.waitFor(() => expect(turnParams()).toHaveLength(2))
    expect(turnParams()[1]!.params).toMatchObject({
      model: 'gpt-5.5',
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: GRANULAR_NEVER,
    })
    expect(runner.info().model).toBe('gpt-5.5')

    await runner.setModel(undefined)
    expect(runner.info().model).toBe('gpt-5.6-terra')

    runner.sendMessage('spin')
    await vi.waitFor(() => expect(turnParams()).toHaveLength(3))
    expect(turnParams()[2]!.params).toMatchObject({ model: 'gpt-5.6-terra' })
    await expect(runner.setModel('gpt-5.2')).rejects.toThrow(/mid-turn/)
    await expect(runner.setPermissionMode('default')).rejects.toThrow(/mid-turn/)
    runner.close()
  })
})

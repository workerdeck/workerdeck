import { afterEach, describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionInfo } from '@workerdeck/protocol'
import { fakeHarness } from './helpers.ts'
import { createSession, get, shellFixture } from './shell-helpers.ts'

const fx = shellFixture('wd-task-routes-')
afterEach(fx.cleanup)

function post(base: string, path: string, token = 'operator') {
  return fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
}

async function waitForStoppable(base: string, id: string): Promise<SessionInfo> {
  for (let i = 0; i < 100; i++) {
    const info = ((await (await get(base, `/sessions/${id}`)).json()) as { session: SessionInfo }).session
    if (info.subagents?.some((sub) => sub.stoppable)) {
      return info
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('no stoppable task appeared')
}

describe('POST /sessions/:id/tasks/:toolUseId/stop', () => {
  it('stops a live background task through the engine and 404s one it cannot stop', async () => {
    const harness = fakeHarness()
    const { base } = await fx.startServer(harness)
    const id = await createSession(base, 'operator', { cwd: fx.tempDir() })
    harness.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'b-1',
      tool_use_id: 'bash-1',
      description: 'node server.js',
      task_type: 'local_bash',
      uuid: 'u-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await waitForStoppable(base, id)

    const stopped = await post(base, `/sessions/${id}/tasks/bash-1/stop`)
    expect(stopped.status).toBe(200)
    expect(harness.stopTask).toHaveBeenCalledWith('b-1')

    expect((await post(base, `/sessions/${id}/tasks/unknown/stop`)).status).toBe(404)
    expect((await get(base, `/sessions/${id}/tasks/bash-1/stop`)).status).toBe(405)
  })
})

describe('POST /sessions/:id/tasks/:toolUseId/background', () => {
  it('moves a foreground task to the background through the engine and 404s one it cannot match', async () => {
    const harness = fakeHarness()
    const { base } = await fx.startServer(harness)
    const id = await createSession(base, 'operator', { cwd: fx.tempDir() })
    harness.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-1',
      model: 'm',
      cwd: '/tmp',
      tools: [],
      skills: [],
      slash_commands: [],
      permissionMode: 'default',
      claude_code_version: '2.0.0',
      mcp_servers: [],
      apiKeySource: 'user',
      uuid: 'u-0',
    } as unknown as SDKMessage)
    for (let i = 0; i < 50 && harness.backgroundTasks.mock.calls.length === 0; i++) {
      const res = await post(base, `/sessions/${id}/tasks/bash-1/background`)
      if (res.status === 200) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(harness.backgroundTasks).toHaveBeenCalledWith('bash-1')
    expect((await post(base, `/sessions/${id}/tasks/unknown/background`)).status).toBe(404)
    expect((await post(base, `/sessions/${id}/tasks/background`)).status).toBe(200)
    expect(harness.backgroundTasks).toHaveBeenLastCalledWith(undefined)
  })
})

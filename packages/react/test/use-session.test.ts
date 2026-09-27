import { describe, expect, it, vi } from 'vitest'
import { WorkerDeckError, type WorkerDeckClient } from '@workerdeck/client'
import type { SessionEvent, SessionEventBody, ShellInfo } from '@workerdeck/protocol'
import { useClaudeSession, type UseClaudeSessionResult } from '../src/hooks/use-session.ts'
import type { ShellItem } from '../src/lib/transcript.ts'
import { renderHook } from './hook-runner.ts'

type Listener = (payload: unknown) => void

class FakeHandle {
  readonly listeners = new Map<string, Set<Listener>>()
  readonly sent: string[] = []
  on(name: string, listener: Listener): () => void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(listener)
    this.listeners.set(name, set)
    return () => set.delete(listener)
  }
  emit(name: string, payload: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(payload)
    }
  }
  send(text: string): void {
    this.sent.push(text)
  }
  detach(): void {}
}

let seq = 0
function ev(body: SessionEventBody): SessionEvent {
  return { ...body, seq: ++seq, ts: 0 } as SessionEvent
}

function shellInfo(): ShellInfo {
  return {
    id: 'sh_1',
    sessionId: 's1',
    ordinal: 1,
    command: 'ls',
    label: 'ls',
    cwd: '/tmp',
    owner: 'user',
    status: 'running',
    startedAt: 1,
    bytes: 1,
    cols: 80,
    rows: 24,
  }
}

function fakeClient(overrides: Partial<Record<'getShell' | 'shellOutput', (...args: unknown[]) => Promise<unknown>>> = {}) {
  const handles: FakeHandle[] = []
  const client = {
    identityKey: `fake-${Math.random()}`,
    attach: () => {
      const handle = new FakeHandle()
      handles.push(handle)
      return handle
    },
    listProfiles: async () => ({ profiles: [] }),
    ...overrides,
  }
  return { client: client as unknown as WorkerDeckClient, handles }
}

function streamDelta(text: string): SessionEvent {
  return ev({
    type: 'stream_delta',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    parentToolUseId: null,
    uuid: `d${seq}`,
  })
}

function shellEvent(): SessionEvent {
  return ev({
    type: 'user_message',
    message: { role: 'user', content: '<local-command-stdout>$ ls\nfile</local-command-stdout>' },
    parentToolUseId: null,
    synthetic: true,
    uuid: 'shell-row',
    shell: shellInfo(),
  })
}

function shellRow(result: UseClaudeSessionResult): ShellItem {
  return result.state.items.find((item): item is ShellItem => item.kind === 'shell')!
}

const ACTIONS = [
  'send',
  'approve',
  'deny',
  'interrupt',
  'clearContext',
  'runShell',
  'setPermissionMode',
  'setModel',
  'closeSession',
] as const

describe('useClaudeSession', () => {
  it('keeps every action identity stable across streamed events', () => {
    const { client, handles } = fakeClient()
    const hook = renderHook(() => useClaudeSession(client, 's1', { cacheTranscript: false }))
    const before = hook.current
    handles[0]!.emit('event', streamDelta('Hel'))
    handles[0]!.emit('event', streamDelta('lo'))
    const after = hook.current
    expect(after.state).not.toBe(before.state)
    for (const name of ACTIONS) {
      expect(after[name], name).toBe(before[name])
    }
    after.send('hi')
    expect(handles[0]!.sent).toEqual(['hi'])
    hook.unmount()
  })

  it('marks a shell row missing only on a 404, and retries verification after a transient failure', async () => {
    const getShell = vi
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockRejectedValueOnce(new WorkerDeckError('boom', 503))
      .mockResolvedValueOnce({ ...shellInfo(), status: 'exited' })
    const { client, handles } = fakeClient({ getShell })
    const hook = renderHook(() => useClaudeSession(client, 's1', { cacheTranscript: false }))
    handles[0]!.emit('event', shellEvent())

    expect(await hook.current.verifyShell('sh_1')).toBe(false)
    expect(shellRow(hook.current).missing).toBeUndefined()
    expect(await hook.current.verifyShell('sh_1')).toBe(false)
    expect(shellRow(hook.current).missing).toBeUndefined()
    expect(await hook.current.verifyShell('sh_1')).toBe(true)
    expect(shellRow(hook.current).shell.status).toBe('exited')
    expect(await hook.current.verifyShell('sh_1')).toBe(false)
    expect(getShell).toHaveBeenCalledTimes(3)
    hook.unmount()
  })

  it('does not re-ask a shell the gateway reported gone', async () => {
    const getShell = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockRejectedValue(new WorkerDeckError('no such shell', 404))
    const { client, handles } = fakeClient({ getShell })
    const hook = renderHook(() => useClaudeSession(client, 's1', { cacheTranscript: false }))
    handles[0]!.emit('event', shellEvent())

    await hook.current.verifyShell('sh_1')
    expect(shellRow(hook.current).missing).toBe(true)
    await hook.current.verifyShell('sh_1')
    expect(getShell).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it('leaves the row intact when loading output fails for a reason other than 404', async () => {
    const shellOutput = vi
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(new WorkerDeckError('overloaded', 500))
      .mockRejectedValueOnce(new WorkerDeckError('gone', 404))
    const { client, handles } = fakeClient({ shellOutput })
    const hook = renderHook(() => useClaudeSession(client, 's1', { cacheTranscript: false }))
    handles[0]!.emit('event', shellEvent())

    expect(await hook.current.loadShellOutput('sh_1')).toBe(false)
    expect(shellRow(hook.current).missing).toBeUndefined()
    expect(await hook.current.loadShellOutput('sh_1')).toBe(false)
    expect(shellRow(hook.current).missing).toBe(true)
    hook.unmount()
  })
})

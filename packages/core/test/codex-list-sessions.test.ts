import { describe, expect, it } from 'vitest'
import { listCodexSessions } from '../src/engines/codex/adapter.ts'
import type { AppServerConnectFn, AppServerConnection, AppServerThreadSummary } from '../src/engines/codex/types.ts'

/** A thread/list row as 0.146.0 returns it (timestamps in epoch SECONDS). */
const row = (over: Partial<AppServerThreadSummary> & { id: string }): AppServerThreadSummary => ({
  name: null,
  preview: 'Create a file named approved.txt',
  createdAt: 1_785_981_891,
  updatedAt: 1_785_982_986,
  cwd: '/tmp/project',
  ephemeral: false,
  gitInfo: null,
  ...over,
})

/** Scripted connection: pages served by index, requests recorded, close counted. */
const scriptedList = (pages: Array<{ data: AppServerThreadSummary[]; nextCursor?: string | null }>) => {
  const requests: Array<{ method: string; params: unknown }> = []
  const notifies: string[] = []
  const envs: Array<Record<string, string>> = []
  let closed = 0
  let page = 0
  const connectFn: AppServerConnectFn = (options) => {
    envs.push(options.env)
    const connection: AppServerConnection = {
      request: async (method, params) => {
        requests.push({ method, params })
        if (method === 'initialize') {
          return {}
        }
        if (method === 'thread/list') {
          return pages[Math.min(page++, pages.length - 1)]
        }
        throw new Error(`unexpected request ${method}`)
      },
      notify: (method) => {
        notifies.push(method)
      },
      onNotification: () => {},
      onRequest: () => {},
      onClose: () => {},
      close: () => {
        closed++
      },
    }
    return connection
  }
  return { connectFn, requests, notifies, envs, closed: () => closed }
}

describe('listCodexSessions', () => {
  it('handshakes like the runner, maps rows to summaries, and closes the child', async () => {
    const peer = scriptedList([
      {
        data: [
          row({ id: 't1', name: 'My thread', gitInfo: { branch: 'main' } }),
          row({ id: 't2', preview: 'second', createdAt: 100, updatedAt: null }),
          row({ id: 'gone', ephemeral: true }), // never materialized — not resumable
        ],
        nextCursor: null,
      },
    ])
    const summaries = await listCodexSessions({
      connectFn: peer.connectFn,
      env: { PATH: '/usr/bin', GONE: undefined },
      profile: { name: 'codex', engine: 'codex', codexHome: '/homes/codex' },
    })

    expect(peer.requests[0]).toMatchObject({
      method: 'initialize',
      params: { capabilities: { experimentalApi: true } },
    })
    expect(peer.notifies).toEqual(['initialized'])
    // The complete child env with the profile's CODEX_HOME pin (undefined
    // entries dropped — spawn env replaces, never merges).
    expect(peer.envs[0]).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/homes/codex' })
    expect(peer.closed()).toBe(1)

    expect(summaries).toEqual([
      {
        sessionId: 't1',
        summary: 'My thread',
        lastModified: 1_785_982_986_000, // seconds → ms
        createdAt: 1_785_981_891_000,
        customTitle: 'My thread',
        firstPrompt: 'Create a file named approved.txt',
        gitBranch: 'main',
        cwd: '/tmp/project',
      },
      {
        sessionId: 't2',
        summary: 'second', // no name — preview is the summary line
        lastModified: 100_000, // no updatedAt — createdAt stands in
        createdAt: 100_000,
        customTitle: undefined,
        firstPrompt: 'second',
        gitBranch: undefined,
        cwd: '/tmp/project',
      },
    ])
  })

  it('walks the cursor until limit+offset is satisfied, and slices exactly', async () => {
    const peer = scriptedList([
      { data: [row({ id: 'a' }), row({ id: 'b' })], nextCursor: 'cur-1' },
      { data: [row({ id: 'c' }), row({ id: 'd' })], nextCursor: 'cur-2' },
      { data: [row({ id: 'e' })], nextCursor: null },
    ])
    const summaries = await listCodexSessions({
      connectFn: peer.connectFn,
      env: {},
      limit: 2,
      offset: 1,
    })
    expect(summaries.map((s) => s.sessionId)).toEqual(['b', 'c'])
    // Two pages were enough for offset 1 + limit 2; the third was never asked for.
    const lists = peer.requests.filter((r) => r.method === 'thread/list')
    expect(lists).toHaveLength(2)
    expect(lists[0]!.params).toMatchObject({ sortKey: 'updated_at' })
    expect(lists[0]!.params).not.toHaveProperty('cursor')
    expect(lists[1]!.params).toMatchObject({ cursor: 'cur-1' })
  })

  it('filters by dir with the exact-match cwd forms, and stops on the last page', async () => {
    const peer = scriptedList([{ data: [row({ id: 'a' })], nextCursor: null }])
    const summaries = await listCodexSessions({
      connectFn: peer.connectFn,
      env: {},
      dir: '/tmp/project',
    })
    expect(summaries).toHaveLength(1)
    const params = peer.requests.find((r) => r.method === 'thread/list')!.params as {
      cwd: string[]
    }
    // The spelled form always; the canonical form too when it differs (macOS
    // records /tmp threads under /private/tmp).
    expect(params.cwd).toContain('/tmp/project')
    expect(peer.requests.filter((r) => r.method === 'thread/list')).toHaveLength(1)
  })

  it('closes the child even when the listing fails', async () => {
    const peer = scriptedList([])
    const failing: AppServerConnectFn = (options) => {
      const connection = peer.connectFn(options)
      return {
        ...connection,
        request: async (method, params) => {
          if (method === 'thread/list') {
            throw new Error('boom')
          }
          return connection.request(method, params)
        },
      }
    }
    await expect(listCodexSessions({ connectFn: failing, env: {} })).rejects.toThrow('boom')
    expect(peer.closed()).toBe(1)
  })
})

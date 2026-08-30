import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerFrame, SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

/** A 1x1 red PNG — small enough to inline, real enough to be a legal upload. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** Minimal fake CLI: records what it was sent, answers nothing. */
const fakeHarness = () => {
  const captured: SDKUserMessage[] = []
  let done = false
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      if (done) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    close: () => {
      done = true
      waiter?.({ value: undefined, done: true })
    },
  } as unknown as Query
  const queryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    void (async () => {
      for await (const input of params.prompt) {
        captured.push(input)
      }
    })()
    return query
  }
  return { captured, queryFn }
}

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

const start = async (harness: ReturnType<typeof fakeHarness>) => {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return { base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
}

const createSession = async (base: string): Promise<string> => {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project' }),
  })
  return ((await res.json()) as { session: SessionInfo }).session.id
}

const upload = async (base: string, id: string, name: string, mediaType: string, body: Buffer | string): Promise<Response> => {
  return await fetch(`${base}/sessions/${id}/attachments?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': mediaType },
    body,
  })
}

/** Attach, run `fn`, and hand back every session event seen. */
const withSocket = async (wsBase: string, id: string, fn: (ws: WebSocket, events: SessionEvent[]) => Promise<void>): Promise<void> => {
  const ws = new WebSocket(`${wsBase}/sessions/${id}/ws`)
  const events: SessionEvent[] = []
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame
    if (frame.type === 'event') {
      events.push(frame.event)
    }
  })
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  try {
    await fn(ws, events)
  } finally {
    ws.close()
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

describe('session attachments', () => {
  it('uploads bytes, sends them as content blocks, and logs only the reference', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await createSession(base)

    const uploaded = (await (await upload(base, id, 'shot.png', 'image/png', PNG)).json()) as {
      attachment: { id: string; name: string; mediaType: string; bytes: number }
    }
    expect(uploaded.attachment).toMatchObject({
      name: 'shot.png',
      mediaType: 'image/png',
      bytes: PNG.length,
    })

    await withSocket(wsBase, id, async (ws, events) => {
      ws.send(
        JSON.stringify({
          type: 'user_message',
          text: 'what is this?',
          attachmentIds: [uploaded.attachment.id],
        }),
      )
      await settle()

      // The CLI gets the bytes: image block first, then the typed text.
      const sent = harness.captured.at(-1)!
      expect(sent.message.content).toEqual([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
        },
        { type: 'text', text: 'what is this?' },
      ])

      // The event log gets the reference and nothing else — no base64 anywhere.
      const logged = events.find((e) => e.type === 'user_message')
      expect(logged).toMatchObject({
        message: { role: 'user', content: 'what is this?' },
        attachments: [{ id: uploaded.attachment.id, name: 'shot.png', mediaType: 'image/png', bytes: PNG.length }],
      })
      expect(JSON.stringify(logged)).not.toContain(PNG.toString('base64'))
    })
  })

  it('sends an attachment with no text at all', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await createSession(base)
    const uploaded = (await (await upload(base, id, 'shot.png', 'image/png', PNG)).json()) as {
      attachment: { id: string }
    }

    await withSocket(wsBase, id, async (ws) => {
      ws.send(JSON.stringify({ type: 'user_message', text: '', attachmentIds: [uploaded.attachment.id] }))
      await settle()
      // No empty text block: the API rejects one, so it is simply absent.
      expect(harness.captured.at(-1)!.message.content).toEqual([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
        },
      ])
    })
  })

  it('inlines a text file in a named envelope rather than as bare user text', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await createSession(base)
    const uploaded = (await (await upload(base, id, 'notes.txt', 'text/plain; charset=utf-8', 'hello there')).json()) as {
      attachment: { id: string; mediaType: string }
    }
    // The charset parameter is normalized away.
    expect(uploaded.attachment.mediaType).toBe('text/plain')

    await withSocket(wsBase, id, async (ws) => {
      ws.send(JSON.stringify({ type: 'user_message', text: 'read it', attachmentIds: [uploaded.attachment.id] }))
      await settle()
      expect(harness.captured.at(-1)!.message.content).toEqual([
        {
          type: 'text',
          text: '<attachment name="notes.txt" type="text/plain">\nhello there\n</attachment>',
        },
        { type: 'text', text: 'read it' },
      ])
    })
  })

  it('serves the bytes back for a thumbnail, as a non-sniffable download', async () => {
    const { base } = await start(fakeHarness())
    const id = await createSession(base)
    const uploaded = (await (await upload(base, id, 'shot.png', 'image/png', PNG)).json()) as {
      attachment: { id: string }
    }

    const res = await fetch(`${base}/sessions/${id}/attachments/${uploaded.attachment.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG)
  })

  it('refuses a media type no model can be shown', async () => {
    const { base } = await start(fakeHarness())
    const id = await createSession(base)
    const res = await upload(base, id, 'thing.bin', 'application/octet-stream', PNG)
    expect(res.status).toBe(415)
    expect(((await res.json()) as { error: string }).error).toMatch(/unsupported media type/)
  })

  it('refuses an upload over the per-file cap', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      attachments: { maxFileBytes: 32 },
      buildRunnerConfig: (req) => ({ ...req, queryFn: fakeHarness().queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    const id = await createSession(base)
    const res = await upload(base, id, 'big.png', 'image/png', Buffer.alloc(64, 1))
    expect(res.status).toBe(413)
  })

  it('fails the whole message rather than sending one that lost its picture', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await createSession(base)

    await withSocket(wsBase, id, async (ws) => {
      const errors: string[] = []
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data)) as ServerFrame
        if (frame.type === 'protocol_error') {
          errors.push(frame.message)
        }
      })
      ws.send(JSON.stringify({ type: 'user_message', text: 'look', attachmentIds: ['nope'] }))
      await settle()
      expect(errors.join()).toMatch(/unknown attachment\(s\): nope/)
      expect(harness.captured).toHaveLength(0)
    })
  })

  it('drops a deleted session’s attachments', async () => {
    const { base } = await start(fakeHarness())
    const id = await createSession(base)
    const uploaded = (await (await upload(base, id, 'shot.png', 'image/png', PNG)).json()) as {
      attachment: { id: string }
    }
    await fetch(`${base}/sessions/${id}`, { method: 'DELETE' })
    // The session is gone, so the route 404s before it ever looks for the file.
    const res = await fetch(`${base}/sessions/${id}/attachments/${uploaded.attachment.id}`)
    expect(res.status).toBe(404)
  })
})

describe('session MCP routes', () => {
  function mcpHarness(status: Array<Record<string, unknown>>) {
    const reconnect = vi.fn(async () => {})
    const toggle = vi.fn(async () => {})
    let done = false
    let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
    const query = {
      [Symbol.asyncIterator]() {
        return this
      },
      next(): Promise<IteratorResult<SDKMessage>> {
        if (done) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => {
          waiter = resolve
        })
      },
      close: () => {
        done = true
        waiter?.({ value: undefined, done: true })
      },
      mcpServerStatus: vi.fn(async () => status),
      reconnectMcpServer: reconnect,
      toggleMcpServer: toggle,
    } as unknown as Query
    const queryFn = () => query
    return { queryFn, reconnect, toggle }
  }

  it('reports servers and their tools without leaking env or headers', async () => {
    const harness = mcpHarness([
      {
        name: 'gtm',
        status: 'connected',
        scope: 'project',
        serverInfo: { name: 'gtm', version: '1.2.0' },
        config: {
          command: 'node',
          args: ['./server.js'],
          // Both of these are secrets, and neither may come back out.
          env: { GTM_TOKEN: 'sk-live-do-not-leak' },
        },
        tools: [{ name: 'TaskUpsert', description: 'Create or update a task' }],
      },
      {
        name: 'remote',
        status: 'failed',
        error: 'connection refused',
        config: { type: 'http', url: 'https://x/mcp', headers: { authorization: 'Bearer nope' } },
      },
    ])
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    const id = await createSession(base)

    const res = await fetch(`${base}/sessions/${id}/mcp`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('sk-live-do-not-leak')
    expect(body).not.toContain('Bearer nope')
    expect(JSON.parse(body)).toEqual({
      servers: [
        {
          name: 'gtm',
          status: 'connected',
          scope: 'project',
          serverInfo: { name: 'gtm', version: '1.2.0' },
          transport: 'stdio',
          command: 'node',
          args: ['./server.js'],
          tools: [{ name: 'TaskUpsert', description: 'Create or update a task' }],
        },
        {
          name: 'remote',
          status: 'failed',
          error: 'connection refused',
          transport: 'http',
          url: 'https://x/mcp',
        },
      ],
    })
  })

  it('reconnects and disables one server, answering with the refreshed list', async () => {
    const harness = mcpHarness([{ name: 'gtm', status: 'connected' }])
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    const id = await createSession(base)

    const post = (action: string) =>
      fetch(`${base}/sessions/${id}/mcp/gtm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })

    expect((await post('reconnect')).status).toBe(200)
    expect(harness.reconnect).toHaveBeenCalledWith('gtm')
    expect((await post('disable')).status).toBe(200)
    expect(harness.toggle).toHaveBeenCalledWith('gtm', false)
    expect((await post('enable')).status).toBe(200)
    expect(harness.toggle).toHaveBeenCalledWith('gtm', true)
    expect((await post('explode')).status).toBe(400)
  })

  it('501s when the session cannot answer for its MCP servers', async () => {
    const { base } = await start(fakeHarness())
    const id = await createSession(base)
    const res = await fetch(`${base}/sessions/${id}/mcp`)
    expect(res.status).toBe(501)
  })
})

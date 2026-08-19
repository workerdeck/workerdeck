/**
 * On-demand tool results, over a real socket and a real route.
 *
 * Three claims are load-bearing here and none of them can be made in a unit
 * test: an attach that did **not** ask for truncation is byte-identical to what
 * this gateway sent before the feature existed (backward compatibility asserted,
 * not argued); an attach that did ask gets the head with its markers; and the
 * rest is one GET away — but only when the caller names the right tool, because
 * a seq alone can point at a different call after a rebuild.
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  TOOL_RESULT_HEAD_CHARS,
  type ServerFrame,
  type SessionEvent,
  type SessionInfo,
  type ToolResultBlock,
} from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

const BIG = 'x'.repeat(TOOL_RESULT_HEAD_CHARS + 12_000)

function fakeHarness() {
  const buffered: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  const emit = (msg: SDKMessage) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: msg, done: false })
    } else buffered.push(msg)
  }
  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      const next = buffered.shift()
      if (next !== undefined) return Promise.resolve({ value: next, done: false })
      if (done) return Promise.resolve({ value: undefined, done: true })
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
      for await (const _ of params.prompt) {
        // The turn's content is emitted by the test, not derived from input.
      }
    })()
    return query
  }
  return { emit, queryFn }
}

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function start(harness: ReturnType<typeof fakeHarness>) {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return { base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
}

async function createSession(base: string): Promise<string> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project' }),
  })
  return ((await res.json()) as { session: SessionInfo }).session.id
}

/** Attach once, collect the replay, close. `query` is the raw suffix. */
async function replay(wsBase: string, id: string, query = ''): Promise<SessionEvent[]> {
  const ws = new WebSocket(`${wsBase}/sessions/${id}/ws${query}`)
  const events: SessionEvent[] = []
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame
    if (frame.type === 'event') events.push(frame.event)
  })
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  await new Promise((resolve) => setTimeout(resolve, 80))
  ws.close()
  return events
}

const resultBlock = (event: SessionEvent | undefined): ToolResultBlock | undefined => {
  if (event?.type !== 'user_message' || !Array.isArray(event.message.content)) return undefined
  return event.message.content.find((b) => b.type === 'tool_result') as ToolResultBlock | undefined
}

/** A settled tool call with a very large result, in the log. */
async function seed(harness: ReturnType<typeof fakeHarness>, base: string) {
  const id = await createSession(base)
  harness.emit({
    type: 'assistant',
    session_id: 's',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'find /' } }],
    },
  } as unknown as SDKMessage)
  harness.emit({
    type: 'user',
    session_id: 's',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: BIG }],
    },
  } as unknown as SDKMessage)
  await new Promise((resolve) => setTimeout(resolve, 60))
  return id
}

describe('truncated replay', () => {
  it('sends the whole result when nobody asked for a head', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await seed(harness, base)

    const events = await replay(wsBase, id)
    const block = resultBlock(events.find((e) => e.type === 'user_message'))
    expect(block?.content).toBe(BIG)
    expect(block?.truncated).toBeUndefined()
    expect(block?.total_chars).toBeUndefined()
  })

  it('sends the head, marked, when the socket asked', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await seed(harness, base)

    const events = await replay(wsBase, id, '?truncateResults=1')
    const block = resultBlock(events.find((e) => e.type === 'user_message'))
    expect(block?.content).toBe(BIG.slice(0, TOOL_RESULT_HEAD_CHARS))
    expect(block?.truncated).toBe(true)
    expect(block?.total_chars).toBe(BIG.length)
  })

  it('leaves the stored log whole — a second, plain attach gets everything', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await seed(harness, base)

    await replay(wsBase, id, '?truncateResults=1')
    const events = await replay(wsBase, id)
    expect(resultBlock(events.find((e) => e.type === 'user_message'))?.content).toBe(BIG)
  })
})

describe('GET /sessions/:id/events/:seq/result', () => {
  const seqOf = (events: SessionEvent[]) =>
    events.find((e) => e.type === 'user_message' && resultBlock(e))!.seq

  it('serves the whole result the replay cut', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await seed(harness, base)
    const seq = seqOf(await replay(wsBase, id, '?truncateResults=1'))

    const res = await fetch(`${base}/sessions/${id}/events/${seq}/result?toolUseId=call-1`)
    expect(res.status).toBe(200)
    expect((await res.json()) as { content: string }).toMatchObject({
      seq,
      toolUseId: 'call-1',
      content: BIG,
      isError: false,
    })
  })

  it('refuses a seq that does not carry the named call, rather than guessing', async () => {
    // The failure this guard exists for: a woken dormant session has a fresh log
    // with fresh seqs, so a cached sourceSeq can name a different event — and
    // being handed another tool's output under the row you pressed is worse than
    // an error.
    const harness = fakeHarness()
    const { base, wsBase } = await start(harness)
    const id = await seed(harness, base)
    const seq = seqOf(await replay(wsBase, id, '?truncateResults=1'))

    expect((await fetch(`${base}/sessions/${id}/events/${seq}/result?toolUseId=other`)).status).toBe(
      404,
    )
    expect((await fetch(`${base}/sessions/${id}/events/${seq}/result`)).status).toBe(400)
    expect(
      (await fetch(`${base}/sessions/${id}/events/99999/result?toolUseId=call-1`)).status,
    ).toBe(404)
  })

  it('404s for an unknown session, like every other session route', async () => {
    const harness = fakeHarness()
    const { base } = await start(harness)
    expect((await fetch(`${base}/sessions/nope/events/1/result?toolUseId=call-1`)).status).toBe(404)
  })
})

import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { JsonRpcError, JsonRpcStdioConnection } from '../src/engines/codex/jsonrpc.ts'

const harness = () => {
  const toClient = new PassThrough() // server stdout → client input
  const fromClient = new PassThrough() // client output → server stdin
  const connection = new JsonRpcStdioConnection({ input: toClient, output: fromClient })
  const written: Array<Record<string, unknown>> = []
  fromClient.on('data', (chunk: Buffer) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) {
        written.push(JSON.parse(line) as Record<string, unknown>)
      }
    }
  })
  return {
    connection,
    written,
    send: (message: object) => toClient.write(JSON.stringify(message) + '\n'),
    sendRaw: (raw: string) => toClient.write(raw),
  }
}

describe('JsonRpcStdioConnection', () => {
  it('frames requests as newline-delimited JSON without a jsonrpc field', async () => {
    const { connection, written, send } = harness()
    const promise = connection.request('initialize', { clientInfo: { name: 'x', version: '0' } })
    connection.notify('initialized')
    await vi.waitFor(() => expect(written).toHaveLength(2))
    // The 0.146.0 binary's envelope: no `jsonrpc` key, and no `params` key when there are none.
    expect(written[0]).toEqual({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'x', version: '0' } },
    })
    expect(written[1]).toEqual({ method: 'initialized' })
    send({ id: 1, result: { codexHome: '/tmp/.codex' } })
    await expect(promise).resolves.toEqual({ codexHome: '/tmp/.codex' })
  })

  it('correlates out-of-order responses and messages split across chunks', async () => {
    const { connection, sendRaw } = harness()
    const first = connection.request('thread/start')
    const second = connection.request('turn/start')
    // Out of order, split mid-JSON across writes, with a notification interleaved.
    sendRaw('{"id":2,"resu')
    sendRaw('lt":{"turn":{"id":"t"}}}\n{"method":"turn/started","params":{"x":1},"emittedAtMs":5}\n')
    sendRaw('{"id":1,"result":{"thread":{"id":"th"}}}\n')
    await expect(second).resolves.toEqual({ turn: { id: 't' } })
    await expect(first).resolves.toEqual({ thread: { id: 'th' } })
  })

  it('rejects a request answered with a JSON-RPC error, keeping the code', async () => {
    const { connection, send } = harness()
    const promise = connection.request('thread/resume', { threadId: 'gone' })
    send({ id: 1, error: { code: -32000, message: 'no such thread' } })
    await expect(promise).rejects.toMatchObject({ code: -32000, message: 'no such thread' })
  })

  it('dispatches notifications and tolerates garbage lines', async () => {
    const { connection, send, sendRaw } = harness()
    const seen: Array<[string, unknown]> = []
    connection.onNotification((method, params) => seen.push([method, params]))
    sendRaw('not json at all\n')
    send({ method: 'item/agentMessage/delta', params: { delta: 'He' }, emittedAtMs: 1 })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual(['item/agentMessage/delta', { delta: 'He' }])
  })

  it('answers server→client requests from the handler, errors on a throw, -32601 unhandled', async () => {
    const { connection, written, send } = harness()
    connection.onRequest(async (method) => {
      if (method === 'item/fileChange/requestApproval') {
        return { decision: 'decline' }
      }
      throw new JsonRpcError(-32601, `unhandled: ${method}`)
    })
    send({ id: 'srv-1', method: 'item/fileChange/requestApproval', params: {} })
    send({ id: 'srv-2', method: 'account/chatgptAuthTokens/refresh', params: {} })
    await vi.waitFor(() => expect(written).toHaveLength(2))
    expect(written[0]).toEqual({ id: 'srv-1', result: { decision: 'decline' } })
    expect(written[1]).toEqual({
      id: 'srv-2',
      error: { code: -32601, message: 'unhandled: account/chatgptAuthTokens/refresh' },
    })
  })

  it('rejects every pending request on fail(), naming the method it stranded', async () => {
    const { connection } = harness()
    const promise = connection.request('turn/start')
    connection.fail('codex app-server exited (code 1): boom')
    await expect(promise).rejects.toThrow(/exited.*awaiting turn\/start/)
    await expect(connection.request('turn/start')).rejects.toThrow(/closed/)
  })
})

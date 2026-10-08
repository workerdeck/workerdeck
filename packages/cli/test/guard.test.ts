import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runGuard } from '../src/lib/guard.ts'

let server: Server | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)))
  server = undefined
})

async function gateway(sessions: unknown[]): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === '/v1/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessions }))
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`
}

async function guard(sessions: unknown[]): Promise<{ code: number; out: string }> {
  const url = await gateway(sessions)
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
  const code = await runGuard(['--url', url])
  vi.restoreAllMocks()
  return { code, out }
}

describe('workerdeck guard', () => {
  it('is busy while an idle session holds a running shell or a background task', async () => {
    const shell = await guard([
      {
        id: 's1',
        status: 'idle',
        shells: [
          { status: 'running', label: 'pnpm build' },
          { status: 'exited', label: 'ls' },
        ],
      },
    ])
    expect(shell.code).toBe(1)
    expect(shell.out).toContain('1 running shell(s): pnpm build')

    const task = await guard([{ id: 's2', status: 'idle', subagents: [{ status: 'running' }, { status: 'done' }] }])
    expect(task.code).toBe(1)
    expect(task.out).toContain('1 background task(s) running')
  })

  it('is safe once shells have exited and tasks are done', async () => {
    const done = await guard([{ id: 's1', status: 'idle', shells: [{ status: 'exited', label: 'ls' }], subagents: [{ status: 'done' }] }])
    expect(done.code).toBe(0)
  })
})

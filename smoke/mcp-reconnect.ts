// pnpm smoke:mcp-reconnect - costs a few haiku turns on the local Claude login.
//
// The unit suite fakes the CLI, so it cannot show that the real CLI honours `reconnectMcpServer` while it waits on one
// of our own tools, nor when the reconnected server's tools reach the model. A green run proves: a server down at
// engine start reports `failed`; a plain send heals it; `mcp_reconnect` heals it from inside a turn; and the model
// calls the healed server's tool, with whether that happened in the same turn reported.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@workerdeck/protocol'
import { SessionRunner } from '@workerdeck/core'
import { fail, finish, note, ok, step } from './lib/report.ts'

type Beacon = { port: number; word: string; armed: boolean; initializes: number; server: Server }

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function beacon(name: string, word: string, port: number, armed: boolean): Promise<Beacon> {
  const state = { port, word, armed, initializes: 0 } as Beacon
  state.server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        state.initializes += 1
      }
      if (!state.armed) {
        res.writeHead(503).end()
        return
      }
      if (msg.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'secret_word', description: 'Returns the secret word.', inputSchema: { type: 'object', properties: {} } }] }
            : msg.method === 'tools/call'
              ? { content: [{ type: 'text', text: word }] }
              : {}
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    })
  })
  await new Promise<void>((resolve) => state.server.listen(port, '127.0.0.1', resolve))
  return state
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function toolCalls(events: SessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'assistant_message' && Array.isArray(event.message.content)
      ? event.message.content.flatMap((block) => (block.type === 'tool_use' ? [String((block as { name: string }).name)] : []))
      : [],
  )
}

function lastText(events: SessionEvent[]): string {
  const texts = events.flatMap((event) =>
    event.type === 'assistant_message' && Array.isArray(event.message.content)
      ? event.message.content.flatMap((block) => (block.type === 'text' ? [String((block as { text: string }).text)] : []))
      : [],
  )
  return texts.at(-1) ?? ''
}

async function statusOf(runner: SessionRunner, name: string): Promise<string | undefined> {
  return (await runner.mcpServers())?.find((server) => server.name === name)?.status
}

async function turn(runner: SessionRunner, events: SessionEvent[], text: string): Promise<SessionEvent[]> {
  const from = events.length
  const results = () => events.slice(from).filter((event) => event.type === 'turn_result').length
  runner.sendMessage(text)
  await waitFor(() => results() > 0, 180_000, 'the turn result')
  return events.slice(from)
}

const env: Record<string, string | undefined> = { ...process.env, WORKERDECK_AUTH_KEY: undefined }
const cwd = mkdtempSync(join(tmpdir(), 'wd-smoke-mcp-'))
const beacons: Beacon[] = []

async function scenario(label: string, name: string, word: string, prompt: string, arm: (b: Beacon) => Promise<void>): Promise<void> {
  step(label)
  const port = await freePort()
  const b = await beacon(name, word, port, false)
  beacons.push(b)
  const runner = new SessionRunner({
    cwd,
    env,
    model: 'haiku',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: { [name]: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } },
  })
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  void runner.start()
  try {
    await waitFor(async () => (await statusOf(runner, name).catch(() => undefined)) === 'failed', 60_000, `${name} to report failed`)
    ok(`${name} is failed at engine start`, `${b.initializes} initialize attempt(s) refused`)
    const sent = turn(runner, events, prompt)
    await arm(b)
    const done = await sent
    const calls = toolCalls(done)
    const status = await statusOf(runner, name)
    const used = calls.some((call) => call.endsWith('secret_word'))
    if (status === 'connected') {
      ok(`${name} connected after the turn`)
    } else {
      fail(`${name} connected after the turn`, `status ${status}`)
    }
    note(`tool calls: ${calls.join(', ') || '(none)'}`)
    if (used && lastText(done).includes(word)) {
      ok('the model called the healed tool in the same turn', word)
    } else {
      const next = await turn(runner, events, `Call the ${name} secret_word tool and reply with only the word it returns.`)
      const later = toolCalls(next).some((call) => call.endsWith('secret_word')) && lastText(next).includes(word)
      if (later) {
        ok('the healed tool reached the model on the next turn (not the same one)', word)
      } else {
        fail('the healed tool reached the model', lastText(next).slice(0, 200))
      }
    }
  } finally {
    runner.close()
  }
}

async function main(): Promise<void> {
  await scenario(
    'heal on send: the server comes up before the next message',
    'beacon_send',
    'PERIWINKLE',
    'Call the beacon_send secret_word tool and reply with only the word it returns. If the tool is missing, say MISSING.',
    async (b) => {
      b.armed = true
    },
  )
  await scenario(
    'mcp_reconnect from inside a turn',
    'beacon_tool',
    'TANGERINE',
    'The beacon_tool MCP server failed at startup but is up now. Call the mcp_reconnect tool first, then call the ' +
      'beacon_tool secret_word tool and reply with only the word it returns.',
    async (b) => {
      const seen = b.initializes
      await waitFor(() => b.initializes > seen, 30_000, 'the send-time heal to try and fail')
      await new Promise((resolve) => setTimeout(resolve, 300))
      b.armed = true
    },
  )
}

try {
  await main()
} catch (error) {
  fail('smoke aborted', String(error))
} finally {
  for (const b of beacons) {
    b.server.close()
  }
}
finish()

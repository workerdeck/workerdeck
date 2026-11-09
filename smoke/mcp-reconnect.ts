// pnpm smoke:mcp-reconnect [reload|codex] - costs a few haiku turns on the local Claude login (codex: a few
// gpt-5.6-luna turns on the local codex login).
//
// The unit suite fakes the CLI, so it cannot show that the real CLI honours `reconnectMcpServer` while it waits on one
// of our own tools, nor when the reconnected server's tools reach the model. A green run proves: a server down at
// engine start reports `failed`; a plain send heals it; `mcp_reconnect` heals it from inside a turn; the model calls
// the healed server's tool, with whether that happened in the same turn reported; and a server added to `.mcp.json`
// after engine start reaches the next turn through `mcp_reload`, without the engine ever reporting asleep.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@workerdeck/protocol'
import { CodexRunner, SessionRunner, connectAppServer, resolveBundledCodexExecutable, type Runner } from '@workerdeck/core'
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
      // A 2025-06-18 server: codex's 2026-07-28 `server/discover` must get -32601 so it falls back to `initialize`.
      if (!['initialize', 'tools/list', 'tools/call', 'ping'].includes(msg.method ?? '')) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }))
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

async function statusOf(runner: Pick<Runner, 'mcpServers'>, name: string): Promise<string | undefined> {
  return (await runner.mcpServers?.())?.find((server) => server.name === name)?.status
}

async function turn(runner: Runner, events: SessionEvent[], text: string): Promise<SessionEvent[]> {
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

async function reloadScenario(): Promise<void> {
  step('mcp_reload adopts a server added after engine start')
  const dir = mkdtempSync(join(tmpdir(), 'wd-smoke-mcp-reload-'))
  const port = await freePort()
  const b = await beacon('beacon_new', 'MARIGOLD', port, true)
  beacons.push(b)
  const runner = new SessionRunner({
    cwd: dir,
    env,
    model: 'haiku',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project', 'local'],
    extraOptions: { settings: { enableAllProjectMcpServers: true } },
  })
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  void runner.start()
  try {
    await waitFor(async () => (await runner.mcpServers().catch(() => undefined)) !== undefined, 60_000, 'the engine to report its servers')
    if ((await statusOf(runner, 'beacon_new')) === undefined) {
      ok('beacon_new is unknown to the running engine')
    } else {
      fail('beacon_new is unknown to the running engine')
    }
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { beacon_new: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } }))
    const first = await turn(
      runner,
      events,
      'A new MCP server named beacon_new was just added to this project\'s .mcp.json. Call the mcp_reload tool, then end your turn.',
    )
    note(`tool calls: ${toolCalls(first).join(', ') || '(none)'}`)
    if (toolCalls(first).some((call) => call.endsWith('mcp_reload'))) {
      ok('the model called mcp_reload')
    } else {
      fail('the model called mcp_reload')
    }
    await waitFor(async () => (await statusOf(runner, 'beacon_new').catch(() => undefined)) === 'connected', 60_000, 'beacon_new to connect after the restart')
    ok('beacon_new connected after the turn, on the restarted engine')
    const asleep = events.some((event) => event.type === 'engine_sleep') || runner.info().engineAsleep === true
    if (asleep) {
      fail('the engine never reported asleep')
    } else {
      ok('the engine never reported asleep', `status ${runner.status}`)
    }
    const next = await turn(runner, events, 'Call the beacon_new secret_word tool and reply with only the word it returns.')
    if (toolCalls(next).some((call) => call.endsWith('secret_word')) && lastText(next).includes('MARIGOLD')) {
      ok('the next turn used the new server', 'MARIGOLD')
    } else {
      fail('the next turn used the new server', lastText(next).slice(0, 200))
    }
    const remembers = await turn(runner, events, 'What did I ask you to call in my very first message? Answer in five words or fewer.')
    if (/reload/i.test(lastText(remembers))) {
      ok('the conversation survived the restart', lastText(remembers).slice(0, 80))
    } else {
      fail('the conversation survived the restart', lastText(remembers).slice(0, 200))
    }
  } finally {
    runner.close()
  }
}

// Codex has no per-server reconnect; its reload must heal a declared server and keep the declared set.
async function codexScenario(): Promise<void> {
  step('codex: mcp_reload heals a declared server that was down at start, mid-turn')
  const codexBin = resolveBundledCodexExecutable()
  if (!codexBin) {
    fail('codex binary resolvable')
    return
  }
  const port = await freePort()
  const b = await beacon('beacon_codex', 'SAFFRON', port, false)
  const steady = await beacon('beacon_steady', 'COBALT', await freePort(), true)
  beacons.push(b, steady)
  const runner = new CodexRunner({
    cwd,
    env,
    model: 'gpt-5.6-luna',
    permissionMode: 'bypassPermissions',
    connectFn: (options) => connectAppServer({ executable: codexBin, ...options }),
    mcpServers: {
      beacon_codex: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
      beacon_steady: { type: 'http', url: `http://127.0.0.1:${steady.port}/mcp` },
    },
  })
  const events: SessionEvent[] = []
  const t0 = Date.now()
  runner.subscribe((event) => {
    events.push(event)
    if (event.type === 'permission_requested') {
      runner.resolvePermission(event.request.id, { behavior: 'allow' })
    }
    if (process.env.WD_SMOKE_DEBUG) {
      const detail = JSON.stringify(event).slice(0, 220)
      console.log(`    [${((Date.now() - t0) / 1000).toFixed(1)}s] ${detail}`)
    }
  })
  void runner.start()
  try {
    const warm = await turn(runner, events, 'Reply with the single word READY.')
    note(`warm-up: ${lastText(warm).slice(0, 40)}; beacon_codex ${await statusOf(runner, 'beacon_codex')}, beacon_steady ${await statusOf(runner, 'beacon_steady')}`)
    b.armed = true
    const done = await turn(
      runner,
      events,
      'The beacon_codex MCP server was down when you started but is up now. Call the mcp_reload tool, then call the ' +
        'beacon_codex secret_word tool and reply with only the word it returns.',
    )
    const calls = toolCalls(done)
    note(`tool calls: ${calls.join(', ') || '(none)'}`)
    const reloaded = done.some(
      (event) =>
        event.type === 'assistant_message' &&
        Array.isArray(event.message.content) &&
        event.message.content.some((block) => block.type === 'tool_use' && String((block as { name: string }).name).includes('mcp_reload')),
    )
    if (reloaded) {
      ok('the model called mcp_reload')
    } else {
      fail('the model called mcp_reload')
    }
    const healed = await statusOf(runner, 'beacon_codex')
    const kept = await statusOf(runner, 'beacon_steady')
    if (healed === 'connected' || lastText(done).includes('SAFFRON')) {
      ok('beacon_codex reachable after the reload', `status ${healed}`)
    } else {
      fail('beacon_codex reachable after the reload', `status ${healed}; ${b.initializes} initialize attempts`)
    }
    if (kept !== undefined) {
      ok('the declared beacon_steady survived the reload', `status ${kept}`)
    } else {
      fail('the declared beacon_steady survived the reload', 'gone from mcpServerStatus/list')
    }
    if (lastText(done).includes('SAFFRON')) {
      ok('the model used the healed tool in the same turn', 'SAFFRON')
    } else {
      const next = await turn(runner, events, 'Call the beacon_codex secret_word tool and reply with only the word it returns.')
      if (lastText(next).includes('SAFFRON')) {
        ok('the healed tool reached the model on the next turn (not the same one)', 'SAFFRON')
      } else {
        fail('the healed tool reached the model', lastText(next).slice(0, 200))
      }
    }
  } finally {
    runner.close()
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('codex')) {
    await codexScenario()
    return
  }
  if (process.argv.includes('reload')) {
    await reloadScenario()
    return
  }
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
  await reloadScenario()
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

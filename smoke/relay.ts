// pnpm smoke:relay   - costs a few short turns: one claude session, one codex session.
//
// `packages/relay` and `packages/server/test/peer-relay.test.ts` prove the wire, the rules and the composed directory
// against scripted runners. What they cannot prove is that a real model, on each engine, finds a remote row in
// `peers_list`, addresses it as `gateway:session`, and that the peer's reply routes back through the relay. This does,
// with one relay and two in-process gateways on their own ports, never touching an instance already running.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollGateway, startRelay } from '@workerdeck/relay'
import { createWorkerServer, type WorkerServer } from '@workerdeck/server'
import type { Runner } from '@workerdeck/core'
import type { SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { fail, finish, note, ok, step } from './lib/report.ts'

const CLAUDE_MODEL = process.env.WD_SMOKE_CLAUDE_MODEL ?? 'haiku'
const CODEX_MODEL = process.env.WD_SMOKE_CODEX_MODEL ?? 'gpt-5.6-luna'
const NONCE = Math.random().toString(36).slice(2, 8).toUpperCase()
const PING = `PING-${NONCE}`
const PONG = `PONG-${NONCE}`

delete process.env.WORKERDECK_AUTH_KEY
delete process.env.WORKERDECK_RELAY_KEY

const root = mkdtempSync(join(tmpdir(), 'wd-relay-smoke-'))
const relayState = join(root, 'relay')
mkdirSync(relayState, { recursive: true })
writeFileSync(join(relayState, 'rules.json'), JSON.stringify({ rules: [{ from: '*', to: '*' }] }))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) {
      fail(what, `timed out after ${Math.round(timeoutMs / 1000)}s`)
      return false
    }
    await sleep(250)
  }
  return true
}

type Gateway = { name: string; server: WorkerServer; base: string }

async function startGateway(name: string, relayUrl: string, key: string): Promise<Gateway> {
  const work = join(root, name)
  mkdirSync(work, { recursive: true })
  const server = createWorkerServer({
    allowUnauthenticated: true,
    profiles: [
      { name: 'claude', configDir: join(homedir(), '.claude') },
      { name: 'codex', engine: 'codex' },
    ],
    allowedCwdRoots: [root],
    relay: { url: relayUrl, gateway: name, key, log: (message) => note(`[${name}] ${message}`) },
    onDiagnostic: (error, where) => note(`[${name}] ${where}: ${error instanceof Error ? error.message : String(error)}`),
  })
  const { port } = await server.listen(0, '127.0.0.1')
  return { name, server, base: `http://127.0.0.1:${port}/v1` }
}

async function createSession(gateway: Gateway, body: Record<string, unknown>): Promise<Runner> {
  const res = await fetch(`${gateway.base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: join(root, gateway.name), ...body }),
  })
  if (!res.ok) {
    throw new Error(`POST /sessions on ${gateway.name} → ${res.status} ${await res.text()}`)
  }
  const { session: info } = (await res.json()) as { session: SessionInfo }
  const runner = gateway.server.registry.get(info.id)
  if (!runner) {
    throw new Error(`session ${info.id} is not in ${gateway.name}'s registry`)
  }
  return runner
}

function watch(runner: Runner, label: string): SessionEvent[] {
  const events: SessionEvent[] = []
  runner.subscribe((event) => {
    events.push(event)
    if (event.type === 'permission_requested') {
      const peerTool = /peers_(list|peek|send)$/.test(event.request.toolName)
      note(`[${label}] ${peerTool ? 'approving' : 'denying'} ${event.request.toolName}`)
      runner.resolvePermission(
        event.request.id,
        peerTool ? { behavior: 'allow' } : { behavior: 'deny', message: 'Only the peer tools are allowed in this test.' },
      )
    }
  })
  return events
}

function toolCalls(events: SessionEvent[]): Array<{ name: string; input: unknown }> {
  const calls: Array<{ name: string; input: unknown }> = []
  for (const event of events) {
    if (event.type === 'assistant_message' && Array.isArray(event.message.content)) {
      for (const block of event.message.content as Array<{ type: string; name?: string; input?: unknown }>) {
        if (block.type === 'tool_use' && block.name) {
          calls.push({ name: block.name, input: block.input })
        }
      }
    }
  }
  return calls
}

function peerMessages(events: SessionEvent[]): Array<Extract<SessionEvent, { type: 'user_message' }>> {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'user_message' }> => event.type === 'user_message' && event.origin !== undefined,
  )
}

function textOf(event: Extract<SessionEvent, { type: 'user_message' }>): string {
  const content = event.message.content
  return typeof content === 'string' ? content : content.map((block) => ('text' in block ? String(block.text) : '')).join('')
}

const cleanups: Array<() => unknown> = []

async function main(): Promise<void> {
  step('relay and two gateways')
  const relay = await startRelay({ stateDir: relayState, port: 0, log: (line) => note(line) })
  cleanups.push(() => relay.close())
  const alphaKey = await enrollGateway(relayState, 'alpha')
  const betaKey = await enrollGateway(relayState, 'beta')
  await relay.reload()
  const alpha = await startGateway('alpha', relay.url, alphaKey)
  const beta = await startGateway('beta', relay.url, betaKey)
  cleanups.push(
    () => alpha.server.close(),
    () => beta.server.close(),
  )
  const online = () =>
    relay
      .status()
      .gateways.filter((row) => row.online)
      .map((row) => row.name)
  if (await waitFor(() => online().length === 2, 15_000, 'both gateways online at the relay')) {
    ok('both gateways online at the relay', relay.url)
  }

  step(`sessions: claude (${CLAUDE_MODEL}) on alpha, codex (${CODEX_MODEL}) on beta`)
  const bolt = await createSession(beta, { profile: 'codex', model: CODEX_MODEL })
  bolt.setTitle('Bolt')
  const boltEvents = watch(bolt, 'codex')
  const astra = await createSession(alpha, { profile: 'claude', model: CLAUDE_MODEL })
  astra.setTitle('Astra')
  const astraEvents = watch(astra, 'claude')
  const published = () => relay.status().gateways.every((row) => row.sessions >= 1)
  if (await waitFor(published, 15_000, 'both sessions published to the relay registry')) {
    ok('both sessions published to the relay registry')
  }

  step('claude lists, peeks and sends across the relay')
  astra.sendMessage(
    'You are in an automated test of cross-gateway messaging. Do exactly this and nothing else:\n' +
      '1. Call peers_list and find the session titled "Bolt"; its id has the form gateway:session.\n' +
      '2. Call peers_peek on that id.\n' +
      `3. Call peers_send to that id with exactly this text: "${PING}: please call peers_list once, then reply to me with ` +
      `peers_send containing exactly ${PONG} and nothing else."\n` +
      '4. Then stop. When a reply arrives later, do not answer it; just say "received".',
  )

  const delivered = () => peerMessages(boltEvents).some((event) => textOf(event).includes(PING))
  if (await waitFor(delivered, 180_000, 'the codex session received the ping')) {
    const message = peerMessages(boltEvents).find((event) => textOf(event).includes(PING))!
    const origin = message.origin!
    ok('the codex session received the ping', `from ${origin.sessionId}`)
    if (origin.hostId === 'alpha' && origin.sessionId === `alpha:${astra.id}` && origin.name === 'Astra') {
      ok('the origin is relay-stamped as alpha:<session> with the sender name')
    } else {
      fail('the origin is relay-stamped as alpha:<session> with the sender name', JSON.stringify(origin))
    }
  }
  const claudeCalls = toolCalls(astraEvents).map((call) => call.name)
  for (const tool of ['peers_list', 'peers_peek', 'peers_send']) {
    if (claudeCalls.some((name) => name.endsWith(tool))) {
      ok(`claude called ${tool}`)
    } else {
      fail(`claude called ${tool}`, claudeCalls.join(', ') || 'no tool calls')
    }
  }
  const sendInput = toolCalls(astraEvents).find((call) => call.name.endsWith('peers_send'))?.input as { sessionId?: string } | undefined
  if (sendInput?.sessionId === `beta:${bolt.id}`) {
    ok('claude addressed the remote id', sendInput.sessionId)
  } else {
    fail('claude addressed the remote id', JSON.stringify(sendInput))
  }

  step('codex replies across the relay')
  const replied = () => peerMessages(astraEvents).some((event) => textOf(event).includes(PONG))
  if (await waitFor(replied, 240_000, 'the claude session received the pong')) {
    const origin = peerMessages(astraEvents).find((event) => textOf(event).includes(PONG))!.origin!
    ok('the claude session received the pong', `from ${origin.sessionId}`)
    if (origin.hostId === 'beta' && origin.sessionId === `beta:${bolt.id}`) {
      ok('the reply origin is beta:<session>')
    } else {
      fail('the reply origin is beta:<session>', JSON.stringify(origin))
    }
    if (origin.hops?.length === 2 && origin.hops[0] === `alpha:${astra.id}` && origin.hops[1] === `beta:${bolt.id}`) {
      ok('the hop chain crossed both gateways', origin.hops.join(' → '))
    } else {
      fail('the hop chain crossed both gateways', JSON.stringify(origin.hops))
    }
  }
  const codexCalls = toolCalls(boltEvents).map((call) => call.name)
  for (const tool of ['peers_list', 'peers_send']) {
    if (codexCalls.some((name) => name.endsWith(tool))) {
      ok(`codex called ${tool}`)
    } else {
      fail(`codex called ${tool}`, codexCalls.join(', ') || 'no tool calls')
    }
  }

  step('relay drop')
  await relay.close()
  await sleep(500)
  const offline = await fetch(`${alpha.base}/sessions`).then((res) => res.ok)
  if (offline) {
    ok('alpha keeps serving with the relay gone')
  } else {
    fail('alpha keeps serving with the relay gone')
  }
}

main()
  .catch((error: unknown) => fail('smoke crashed', error instanceof Error ? (error.stack ?? error.message) : String(error)))
  .finally(async () => {
    for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
      try {
        await cleanup()
      } catch {}
    }
    rmSync(root, { recursive: true, force: true })
    finish()
  })

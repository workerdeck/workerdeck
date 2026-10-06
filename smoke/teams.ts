// pnpm smoke:teams   - costs a few short turns: three claude sessions, one codex session.
//
// `packages/server/test/agents.test.ts` and the peers matrix prove the team rule against scripted runners. What they
// cannot prove is what a real model sees: that each engine's `peers_list` shows its team and hides what the rule
// hides, that a send across the rule reads as an unknown id, that a lead reaches its members and a member answers its
// lead, and that the brief reaches the model as instructions. One private in-process gateway, never a running one.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkerServer, type WorkerServer } from '@workerdeck/server'
import type { Runner } from '@workerdeck/core'
import type { AgentResponse, CreateAgentRequest, SessionEvent } from '@workerdeck/protocol'
import { fail, finish, note, ok, step } from './lib/report.ts'

const CLAUDE_MODEL = process.env.WD_SMOKE_CLAUDE_MODEL ?? 'haiku'
const CODEX_MODEL = process.env.WD_SMOKE_CODEX_MODEL ?? 'gpt-5.6-luna'
const NONCE = Math.random().toString(36).slice(2, 8).toUpperCase()
const PING = `PING-${NONCE}`
const PONG = `PONG-${NONCE}`
const CODENAME = `KESTREL-${NONCE}`
const PROBE = `PROBE-${NONCE}`

delete process.env.WORKERDECK_AUTH_KEY
delete process.env.WORKERDECK_RELAY_KEY

const root = mkdtempSync(join(tmpdir(), 'wd-teams-smoke-'))
const work = join(root, 'project')
mkdirSync(work, { recursive: true })

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

function check(passed: boolean, what: string, detail?: string): void {
  if (passed) {
    ok(what, detail)
  } else {
    fail(what, detail)
  }
}

type Member = { id: string; agentId: string; runner: Runner; events: SessionEvent[] }

async function createAgent(server: WorkerServer, base: string, label: string, body: CreateAgentRequest): Promise<Member> {
  const res = await fetch(`${base}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, config: { cwd: work, ...body.config } }),
  })
  if (!res.ok) {
    throw new Error(`POST /agents (${label}) → ${res.status} ${await res.text()}`)
  }
  const { agent, session } = (await res.json()) as AgentResponse
  if (!session) {
    throw new Error(`POST /agents (${label}) answered no session`)
  }
  const runner = server.registry.get(session.id)
  if (!runner) {
    throw new Error(`session ${session.id} is not in the registry`)
  }
  return { id: session.id, agentId: agent.id, runner, events: watch(runner, label) }
}

function watch(runner: Runner, label: string): SessionEvent[] {
  const events: SessionEvent[] = []
  runner.subscribe((event) => {
    events.push(event)
    if (event.type === 'permission_requested') {
      const allowed = /(peers_(list|peek|send)|session_info)$/.test(event.request.toolName)
      note(`[${label}] ${allowed ? 'approving' : 'denying'} ${event.request.toolName}`)
      runner.resolvePermission(
        event.request.id,
        allowed ? { behavior: 'allow' } : { behavior: 'deny', message: 'Only the peer tools are allowed in this test.' },
      )
    }
  })
  return events
}

type Block = { type: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown }

function blocks(events: SessionEvent[], type: 'assistant_message' | 'user_message'): Block[] {
  const out: Block[] = []
  for (const event of events) {
    if (event.type === type && Array.isArray(event.message.content)) {
      out.push(...(event.message.content as Block[]))
    }
  }
  return out
}

function calls(events: SessionEvent[], tool: string): Block[] {
  return blocks(events, 'assistant_message').filter((b) => b.type === 'tool_use' && b.name?.endsWith(tool))
}

function resultText(events: SessionEvent[], tool: string): string {
  const ids = new Set(calls(events, tool).map((b) => b.id))
  return blocks(events, 'user_message')
    .filter((b) => b.type === 'tool_result' && ids.has(b.tool_use_id))
    .map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)))
    .join('\n')
}

function peerMessages(events: SessionEvent[]): string[] {
  return events
    .filter((e): e is Extract<SessionEvent, { type: 'user_message' }> => e.type === 'user_message' && e.origin !== undefined)
    .map((e) =>
      typeof e.message.content === 'string'
        ? e.message.content
        : e.message.content.map((b) => ('text' in b ? String(b.text) : '')).join(''),
    )
}

function prose(events: SessionEvent[]): string {
  return events
    .filter((e): e is Extract<SessionEvent, { type: 'assistant_message' }> => e.type === 'assistant_message' && e.parentToolUseId === null)
    .map((e) =>
      typeof e.message.content === 'string'
        ? e.message.content
        : e.message.content.map((b) => ((b as Block).type === 'text' ? (b as { text: string }).text : '')).join(''),
    )
    .join('\n')
}

function idle(member: Member): boolean {
  return member.runner.info().status === 'idle'
}

function turnsDone(member: Member, n: number): boolean {
  return member.events.filter((e) => e.type === 'turn_result').length >= n && idle(member)
}

function listing(what: string, text: string, sees: Array<[string, string]>, hides: Array<[string, string]>): void {
  for (const [name, id] of sees) {
    check(text.includes(id), `${what} lists ${name}`)
  }
  for (const [name, id] of hides) {
    check(!text.includes(id), `${what} does not list ${name}`)
  }
}

const cleanups: Array<() => unknown> = []

async function main(): Promise<void> {
  step('private gateway')
  const server = createWorkerServer({
    allowUnauthenticated: true,
    profiles: [
      { name: 'claude', configDir: join(homedir(), '.claude') },
      { name: 'codex', engine: 'codex' },
    ],
    allowedCwdRoots: [root],
    onDiagnostic: (error, where) => note(`${where}: ${error instanceof Error ? error.message : String(error)}`),
  })
  const { port } = await server.listen(0, '127.0.0.1')
  cleanups.push(() => server.close())
  const base = `http://127.0.0.1:${port}/v1`
  ok('gateway listening', base)

  step(`agents: lead + claude member (${CLAUDE_MODEL}), codex member (${CODEX_MODEL}), solo outsider`)
  const claudeConfig = { profile: 'claude', model: CLAUDE_MODEL }
  const lead = await createAgent(server, base, 'lead', {
    name: 'Atlas',
    config: { ...claudeConfig, brief: `Your codename is ${CODENAME}. Say it whenever you are asked for your codename.` },
  })
  const scout = await createAgent(server, base, 'scout', { name: 'Scout', lead: lead.agentId, config: claudeConfig })
  const bolt = await createAgent(server, base, 'bolt', { name: 'Bolt', lead: lead.agentId, config: { profile: 'codex', model: CODEX_MODEL } })
  const other = await createAgent(server, base, 'other', { name: 'Outsider', config: claudeConfig })
  note(`lead ${lead.id}, scout ${scout.id}, bolt ${bolt.id}, outsider ${other.id}`)
  const list = (await (await fetch(`${base}/sessions`)).json()) as { sessions: Array<{ id: string; agent?: { lead?: string; team?: string; leads?: true } }> }
  const row = (m: Member) => list.sessions.find((s) => s.id === m.id)?.agent
  check(row(lead)?.leads === true, 'the lead row is decorated as leading')
  check(row(bolt)?.lead === lead.agentId && row(bolt)?.team === 'Atlas', 'a member row names its lead and team', JSON.stringify(row(bolt)))
  check(row(other)?.lead === undefined && row(other)?.leads === undefined, 'the outsider is plain top-level')
  await waitFor(() => [lead, scout, bolt, other].every(idle), 120_000, 'all four sessions idle')

  step('outsider: lists, then tries a member it cannot reach')
  other.runner.sendMessage(
    'You are in an automated test of session messaging. Do exactly this and nothing else:\n' +
      '1. Call peers_list once.\n' +
      `2. Call peers_send with sessionId "${bolt.id}" and text "${PROBE}".\n` +
      '3. Reply with the exact text the peers_send tool returned, then stop.',
  )
  if (await waitFor(() => turnsDone(other, 1), 180_000, 'the outsider turn')) {
    listing('outsider peers_list', resultText(other.events, 'peers_list'), [['the lead', lead.id]], [['scout (member)', scout.id], ['bolt (member)', bolt.id]])
    const refusal = resultText(other.events, 'peers_send')
    check(calls(other.events, 'peers_send').length >= 1, 'the outsider attempted the send')
    check(/no such session/i.test(refusal), 'the refusal reads as an unknown id', refusal.slice(0, 160))
    await sleep(2000)
    check(!peerMessages(bolt.events).some((t) => t.includes(PROBE)), 'the member never received the probe')
  }

  step('lead (claude): brief, team listing, ping a member')
  lead.runner.sendMessage(
    'You are in an automated test of team messaging. Do exactly this and nothing else:\n' +
      '1. Call peers_list once.\n' +
      `2. Call peers_send to the session named "Bolt" with exactly: "${PING}: call peers_list once, then reply to me ` +
      `with peers_send containing exactly ${PONG} and nothing else."\n` +
      '3. Reply with your codename, then stop. When a reply arrives later, just say "received".',
  )
  if (await waitFor(() => turnsDone(lead, 1), 180_000, 'the lead turn')) {
    const text = resultText(lead.events, 'peers_list')
    listing('lead peers_list', text, [['scout', scout.id], ['bolt', bolt.id], ['the outsider', other.id]], [])
    check(/"role":\s*"member"|role: member|\bmember\b/.test(text), 'lead peers_list marks members by role', text.slice(0, 200))
    check(prose(lead.events).includes(CODENAME), 'the brief reached the model as instructions', CODENAME)
  }

  step('member (codex): receives, lists its team, answers the lead')
  if (await waitFor(() => peerMessages(bolt.events).some((t) => t.includes(PING)), 180_000, 'the codex member received the ping')) {
    ok('the codex member received the ping')
  }
  if (await waitFor(() => peerMessages(lead.events).some((t) => t.includes(PONG)), 240_000, 'the lead received the pong')) {
    ok('the lead received the pong')
  }
  listing('codex member peers_list', resultText(bolt.events, 'peers_list'), [['its lead', lead.id], ['its teammate', scout.id]], [['the outsider', other.id]])

  step('member (claude): lists its team')
  scout.runner.sendMessage('Automated test: call peers_list once, then reply with just "done".')
  if (await waitFor(() => turnsDone(scout, 1), 180_000, 'the claude member turn')) {
    const text = resultText(scout.events, 'peers_list')
    listing('claude member peers_list', text, [['its lead', lead.id], ['its teammate', bolt.id]], [['the outsider', other.id]])
    check(text.includes('Atlas'), 'the member sees its team named after the lead')
  }

  for (const m of [lead, scout, bolt, other]) {
    const errors = m.events.filter((e) => e.type === 'session_error')
    if (errors.length > 0) {
      fail(`no session_error on ${m.id}`, JSON.stringify(errors))
    }
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

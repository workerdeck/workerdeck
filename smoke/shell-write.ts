// pnpm smoke:shell-write [claude|codex|all]   - costs a few short turns per engine.
//
// The shell write path (`--shell-agent-write gated`) against real engines. The fake harnesses in
// core/test/{claude,codex}-shells.test.ts prove the wiring; only a real CLI can show what Claude Code does with an
// `mcp__workerdeck__shell_*` prompt in each mode, and that a real codex reaches the gateway-raised card before its
// dynamic tool call is answered.
//
// Spawns its OWN gateway on its own port and state dir, like smoke:restart, and never touches a running instance.
//
// Per engine: (1) gated, the agent starts smoke/tui-demo.sh with shell_run, presses keys with shell_write, reads the
// screen and kills it; every card is allowed and must carry its payload verbatim. (2) a denied shell_run creates no
// shell. (3) the takeover: the smoke opens a user shell with `$`, the agent's shell_write into it is refused by name,
// it asks with shell_request_write, the smoke allows, the write lands, the smoke revokes over REST and the next write
// is refused again. (4) the modes the plan left unverified are observed and reported, never failed: claude dontAsk
// and auto, codex auto.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import type { PermissionMode, PermissionRequest, ServerFrame, SessionInfo, ShellInfo } from '@workerdeck/protocol'
import { fail, finish, note, ok, step, warn } from './lib/report.ts'

const arg = process.argv[2] ?? 'all'
const engines = arg === 'all' ? (['claude', 'codex'] as const) : ([arg === 'codex' ? 'codex' : 'claude'] as const)

const PORT = 8792
const base = `http://127.0.0.1:${PORT}/v1`
const TUI = resolve('smoke/tui-demo.sh')

const root = mkdtempSync(join(tmpdir(), 'wd-shell-write-'))
const stateDir = join(root, 'state')
const workDir = join(root, 'work')
const configPath = join(root, 'gateway.config.mjs')
mkdirSync(workDir, { recursive: true })

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}

let child: ChildProcess | undefined

async function startGateway(): Promise<void> {
  writeFileSync(
    configPath,
    `export default {\n  profiles: [\n    { name: 'claude', configDir: \`\${process.env.HOME}/.claude\` },\n` +
      `    { name: 'codex', engine: 'codex' },\n  ],\n  allowedCwdRoots: [${JSON.stringify(root)}],\n}\n`,
  )
  child = spawn(
    process.execPath,
    [
      '--conditions=@workerdeck/source',
      '--import',
      '@swc-node/register/esm-register',
      'packages/cli/src/cli.ts',
      '--config',
      configPath,
      '--port',
      String(PORT),
      '--host',
      '127.0.0.1',
      '--state-dir',
      stateDir,
      '--no-web',
      '--shell',
      '--shell-agent-write',
      'gated',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WORKERDECK_AUTH_KEY: undefined } },
  )
  child.stderr?.on('data', (d) => {
    const text = String(d).trim()
    if (text && process.env.WD_SMOKE_DEBUG) {
      console.log(`    \u001b[2m[gateway] ${text}\u001b[0m`)
    }
  })
  const deadline = Date.now() + 120_000
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('gateway did not come up within 120s')
    }
    try {
      if ((await fetch(`${base}/sessions`)).ok) {
        return
      }
    } catch {}
    await sleep(200)
  }
}

async function stopGateway(): Promise<void> {
  if (!child) {
    return
  }
  const dead = new Promise<void>((r) => child!.once('exit', () => r()))
  child.kill('SIGINT')
  await Promise.race([dead, sleep(10_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  child = undefined
}

type Decide = (request: PermissionRequest) => 'allow' | 'deny'

type Turn = { text: string; cards: PermissionRequest[]; policy: PermissionRequest[]; tools: string[]; done: boolean }

function isShellTool(name: string): boolean {
  return /(^|__)shell_(run|write|kill|read|list|request_write)$/.test(name)
}

function bare(name: string): string {
  return name.replace(/^mcp__workerdeck__/, '')
}

async function turn(id: string, prompt: string, decide: Decide, opts: { mode?: PermissionMode; timeoutMs?: number } = {}): Promise<Turn> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/sessions/${id}/ws?afterSeq=0`)
  const result: Turn = { text: '', cards: [], policy: [], tools: [], done: false }
  let live = false
  const resolved = new Map<string, string>()
  const settled = new Promise<void>((resolveTurn) => {
    const timer = setTimeout(resolveTurn, opts.timeoutMs ?? 240_000)
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame
      if (frame.type !== 'event' || !live) {
        return
      }
      const event = frame.event
      if (event.type === 'permission_requested') {
        result.cards.push(event.request)
        const behavior = decide(event.request)
        ws.send(
          JSON.stringify({
            type: 'permission_decision',
            requestId: event.request.id,
            behavior,
            ...(behavior === 'deny' ? { message: 'denied by the smoke' } : {}),
          }),
        )
        return
      }
      if (event.type === 'permission_resolved') {
        resolved.set(event.requestId, event.resolvedBy ?? 'client')
        if (event.resolvedBy === 'policy') {
          const card = result.cards.find((c) => c.id === event.requestId)
          if (card) {
            result.policy.push(card)
          }
        }
        return
      }
      if (event.type === 'assistant_message' && Array.isArray(event.message.content)) {
        for (const part of event.message.content) {
          if (part.type === 'text') {
            result.text += part.text
          }
          if (part.type === 'tool_use') {
            result.tools.push(bare(String(part.name)))
          }
        }
      }
      if (event.type === 'turn_result') {
        result.done = true
        clearTimeout(timer)
        resolveTurn()
      }
    })
  })
  await new Promise<void>((r, j) => {
    ws.once('open', () => r())
    ws.once('error', j)
  })
  await sleep(1_500)
  live = true
  if (opts.mode) {
    ws.send(JSON.stringify({ type: 'set_permission_mode', mode: opts.mode }))
    await sleep(500)
  }
  ws.send(JSON.stringify({ type: 'user_message', text: prompt }))
  await settled
  ws.close()
  if (process.env.WD_SMOKE_DEBUG) {
    note(`tools ${result.tools.join(', ') || 'none'}; cards ${result.cards.map((c) => bare(c.toolName)).join(', ') || 'none'}`)
    note(`text ${JSON.stringify(result.text.slice(0, 200))}`)
  }
  return result
}

async function shells(id: string): Promise<ShellInfo[]> {
  return (await api<{ shells: ShellInfo[] }>(`/sessions/${id}/shells`)).shells
}

const allowShell: Decide = (request) => (isShellTool(request.toolName) ? 'allow' : 'deny')

async function create(engine: 'claude' | 'codex', mode: PermissionMode): Promise<string> {
  const created = await api<{ session: SessionInfo }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd: workDir, profile: engine, permissionMode: mode, ...(engine === 'claude' ? { model: 'sonnet' } : {}) }),
  })
  return created.session.id
}

const GATED_PROMPT =
  'This is an automated test of your shell tools. Do not use Bash or any command tool. Steps:\n' +
  `1. Call shell_run with command "bash ${TUI}" and waitFor "tui-demo ready".\n` +
  '2. Call shell_write on that shell with keys ["3"] (it switches to the Config page).\n' +
  '3. Call shell_read on it with view "screen".\n' +
  '4. Call shell_kill on it.\n' +
  'Then reply with one line: the names of the items marked [x] on the Config page, comma separated.'

async function gated(engine: 'claude' | 'codex'): Promise<void> {
  step(`${engine}: gated, allow every card`)
  const id = await create(engine, 'default')
  note(`session ${id}`)
  const run = await turn(id, GATED_PROMPT, allowShell)
  if (!run.done) {
    fail('the turn finished', 'no turn_result within the budget')
  }
  const byTool = (name: string) => run.cards.filter((c) => bare(c.toolName) === name)
  const runCard = byTool('shell_run')[0]
  if (runCard && String(runCard.input.command ?? '').includes('tui-demo.sh')) {
    ok('shell_run raised a card carrying the command', JSON.stringify(runCard.input.command))
  } else {
    fail(
      'shell_run raised a card carrying the command',
      `cards: ${run.cards.map((c) => `${c.toolName} ${JSON.stringify(c.input)}`).join(' | ') || 'none'}`,
    )
  }
  const writeCard = byTool('shell_write')[0]
  if (writeCard && JSON.stringify(writeCard.input).includes('3')) {
    ok('shell_write raised a card carrying the keys', JSON.stringify(writeCard.input.keys ?? writeCard.input.data))
  } else {
    fail('shell_write raised a card carrying the keys', writeCard ? JSON.stringify(writeCard.input) : 'no shell_write card')
  }
  if (byTool('shell_kill').length > 0) {
    ok('shell_kill raised a card')
  } else {
    fail('shell_kill raised a card', `tools used: ${run.tools.join(', ')}`)
  }
  const readCards = run.cards.filter((c) => ['shell_read', 'shell_list'].includes(bare(c.toolName)) && !run.policy.includes(c))
  if (readCards.length === 0) {
    ok('the read tools waited on no click')
  } else {
    fail('the read tools waited on no click', readCards.map((c) => c.toolName).join(', '))
  }
  const text = run.text.toLowerCase()
  if (text.includes('hot module reload') && text.includes('source maps') && text.includes('verbose errors')) {
    ok('the screen reached the agent', JSON.stringify(run.text.trim().slice(-120)))
  } else {
    fail('the screen reached the agent', JSON.stringify(run.text.trim().slice(-200)))
  }
  const listed = await shells(id)
  const mine = listed.filter((s) => s.owner === 'agent')
  if (mine.length === 1 && mine[0]!.status === 'exited') {
    ok('one agent-owned shell, ended', `${mine[0]!.id} ${mine[0]!.endReason ?? ''}${mine[0]!.interactive ? ', interactive' : ''}`)
  } else {
    fail('one agent-owned shell, ended', JSON.stringify(mine.map((s) => ({ owner: s.owner, status: s.status }))))
  }
}

async function denied(engine: 'claude' | 'codex'): Promise<void> {
  step(`${engine}: gated, deny the card`)
  const id = await create(engine, 'default')
  const run = await turn(
    id,
    'This is an automated test. Do not use Bash or any command tool. Call shell_run once with command "echo denied-probe". ' +
      'If it is refused, do not retry: reply with one line saying it was refused.',
    () => 'deny',
  )
  const card = run.cards.find((c) => bare(c.toolName) === 'shell_run')
  if (card) {
    ok('shell_run raised a card', JSON.stringify(card.input.command))
  } else {
    fail('shell_run raised a card', `tools used: ${run.tools.join(', ') || 'none'}`)
  }
  const listed = await shells(id)
  if (listed.length === 0) {
    ok('a denied shell_run created no shell')
  } else {
    fail('a denied shell_run created no shell', `${listed.length} shell(s)`)
  }
  if (run.done) {
    ok('the turn still finished')
  } else {
    fail('the turn still finished', 'no turn_result')
  }
}

// A `$` from the composer, as the operator types it: the shell is owned by the user.
async function userShell(id: string, command: string): Promise<ShellInfo> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/sessions/${id}/ws`)
  await new Promise<void>((r, j) => {
    ws.once('open', () => r())
    ws.once('error', j)
  })
  ws.send(JSON.stringify({ type: 'shell_command', command }))
  const deadline = Date.now() + 15_000
  try {
    for (;;) {
      const shell = (await shells(id)).find((s) => s.command === command)
      if (shell && shell.bytes > 0) {
        return shell
      }
      if (Date.now() > deadline) {
        throw new Error(`the user shell ${JSON.stringify(command)} never started`)
      }
      await sleep(250)
    }
  } finally {
    ws.close()
  }
}

async function takeover(engine: 'claude' | 'codex'): Promise<void> {
  step(`${engine}: the takeover of a user shell, then a revoke`)
  const id = await create(engine, 'default')
  note(`session ${id}`)
  const session = await api<{ session: SessionInfo }>(`/sessions/${id}`)
  if (session.session.shellAgentWrite === 'gated') {
    ok('the session tells clients the agent holds the write tools')
  } else {
    fail('the session tells clients the agent holds the write tools', JSON.stringify(session.session.shellAgentWrite))
  }
  const shell = await userShell(id, `bash ${TUI}`)
  note(`user shell ${shell.id}`)
  const run = await turn(
    id,
    'This is an automated test of your shell tools. Do not use Bash or any command tool. Steps:\n' +
      `1. Call shell_write on shell ${shell.id} with keys ["3"].\n` +
      '2. That shell was started by the user, so step 1 is refused. Call shell_request_write on it with reason ' +
      '"switch the demo to its Config page".\n' +
      `3. Call shell_write on shell ${shell.id} with keys ["3"] and waitFor "[x]" again.\n` +
      '4. Call shell_read on it with view "screen".\n' +
      'Then reply with one line: the names of the items marked [x] on the Config page, comma separated.',
    allowShell,
  )
  if (!run.done) {
    fail('the turn finished', 'no turn_result within the budget')
  }
  const request = run.cards.find((c) => bare(c.toolName) === 'shell_request_write')
  if (request && request.input.shellId === shell.id && String(request.input.reason ?? '').length > 0) {
    ok('shell_request_write raised a card naming the shell and the reason', JSON.stringify(request.input.reason))
  } else {
    fail(
      'shell_request_write raised a card naming the shell and the reason',
      `cards: ${run.cards.map((c) => `${bare(c.toolName)} ${JSON.stringify(c.input)}`).join(' | ') || 'none'}`,
    )
  }
  const granted = (await shells(id)).find((s) => s.id === shell.id)
  if (granted?.agentWrite === true && granted.status === 'running') {
    ok('allow set the grant on the record')
  } else {
    fail('allow set the grant on the record', JSON.stringify(granted))
  }
  const text = run.text.toLowerCase()
  if (text.includes('hot module reload') && text.includes('source maps') && text.includes('verbose errors')) {
    ok('the granted write landed and the agent read the screen', JSON.stringify(run.text.trim().slice(-120)))
  } else {
    fail('the granted write landed and the agent read the screen', JSON.stringify(run.text.trim().slice(-200)))
  }

  const revoked = await api<{ shell: ShellInfo }>(`/sessions/${id}/shells/${shell.id}/agent-write`, {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  })
  if (revoked.shell.agentWrite === undefined) {
    ok('the operator revoked the grant over REST')
  } else {
    fail('the operator revoked the grant over REST', JSON.stringify(revoked.shell))
  }
  const after = await turn(
    id,
    `This is an automated test. Do not use Bash or any command tool. Call shell_write on shell ${shell.id} with keys ["1"]. ` +
      'Do not call shell_request_write and do not retry. Reply with the exact text the tool returned.',
    allowShell,
  )
  if (after.text.includes('started by the user')) {
    ok('the next write was refused with the rule named', JSON.stringify(after.text.trim().slice(0, 160)))
  } else {
    fail('the next write was refused with the rule named', JSON.stringify(after.text.trim().slice(0, 200)))
  }
  await api(`/sessions/${id}/shells/${shell.id}/kill`, { method: 'POST' })
}

async function observe(engine: 'claude' | 'codex', mode: PermissionMode): Promise<void> {
  step(`${engine}: what ${mode} does to shell_run (observed, not asserted)`)
  const id = await create(engine, mode)
  const run = await turn(
    id,
    'This is an automated test. Do not use Bash or any command tool. Call shell_run once with command "echo mode-probe" ' +
      'and waitFor "mode-probe". Reply with one line: whether it ran, and the output if it did.',
    allowShell,
  )
  const card = run.cards.find((c) => bare(c.toolName) === 'shell_run')
  const ran = (await shells(id)).some((s) => s.command.includes('mode-probe'))
  const how = card ? (run.policy.includes(card) ? 'a card resolved by policy' : 'a card the smoke allowed') : 'no card'
  if (!run.tools.includes('shell_run')) {
    warn(`${mode}: the model never called shell_run`, JSON.stringify(run.text.trim().slice(0, 160)))
    return
  }
  note(`${mode}: ${how}; the shell ${ran ? 'ran' : 'did NOT run'}`)
  if (!ran) {
    note(`reply: ${JSON.stringify(run.text.trim().slice(0, 200))}`)
  }
  ok(`${mode} observed`)
}

async function main(): Promise<void> {
  console.log(`\n\u001b[1mThe shell write path, against real engines\u001b[0m - port ${PORT}`)
  console.log(`\u001b[2mstate ${stateDir}\u001b[0m`)
  try {
    await startGateway()
    for (const engine of engines) {
      await gated(engine)
      await denied(engine)
      await takeover(engine)
      for (const mode of engine === 'claude' ? (['dontAsk', 'auto'] as const) : (['auto'] as const)) {
        await observe(engine, mode)
      }
    }
  } finally {
    await stopGateway()
    rmSync(root, { recursive: true, force: true })
  }
}

main()
  .catch((error: unknown) => {
    fail('the smoke ran to the end', error instanceof Error ? error.message : String(error))
  })
  .finally(() => finish())

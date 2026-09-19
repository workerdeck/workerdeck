// pnpm smoke:hot-reload   - costs two short turns.
//
// `packages/cli/test/reload-command.test.ts` can show that the signal is sent to the right pid and nothing else.
// What it cannot show is the whole point of the feature: that the gateway re-evaluates its own source WHILE a turn
// is in flight and the engine child, its tool call and the conversation all come out the other side.
//
// It spawns its OWN gateway on its own port with its own state dir and never touches an instance already running.
//
// What a green run proves, in order: a turn is in flight with a real engine child under the gateway; `workerdeck
// reload` swaps the code without restarting the process (same gateway pid, same engine child pid, a new
// generation in the log); the tool call that spanned the reload returns its real output; and a second turn recalls
// a word from before the reload, which is the only check that tells a carried conversation apart from a resumed one.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { ServerFrame, SessionEvent, SessionInfo } from '@workerdeck/protocol'

const WORD = 'ORRERY'
// Not 879x: that block is busy on this machine, and a smoke that cannot listen reports as a gateway that will not start.
const PORT = 8873
const base = `http://127.0.0.1:${PORT}/v1`

const root = mkdtempSync(join(tmpdir(), 'wd-hot-'))
const stateDir = join(root, 'state')
const workDir = join(root, 'work')
const configPath = join(root, 'gateway.config.mjs')
mkdirSync(workDir, { recursive: true })

let pass = 0
let fail = 0
function ok(what: string, detail = '') {
  pass++
  console.log(`  \u001b[32m✓\u001b[0m ${what}${detail ? ` \u001b[2m${detail}\u001b[0m` : ''}`)
}
function bad(what: string, detail = '') {
  fail++
  console.log(`  \u001b[31m✗\u001b[0m ${what}${detail ? ` \u001b[2m${detail}\u001b[0m` : ''}`)
}
function step(what: string) {
  return console.log(`\n\u001b[1m${what}\u001b[0m`)
}
function sleep(ms: number): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}`)
  }
  return (await res.json()) as T
}

const NODE_ARGS = ['--conditions=@workerdeck/source', '--import', '@swc-node/register/esm-register', 'packages/cli/src/cli.ts']

let child: ChildProcess | undefined
let log = ''

async function startGateway(): Promise<void> {
  writeFileSync(
    configPath,
    `export default {\n  profiles: [{ name: 'claude', configDir: \`\${process.env.HOME}/.claude\` }],\n` +
      `  allowedCwdRoots: [${JSON.stringify(root)}],\n}\n`,
  )
  child = spawn(
    process.execPath,
    [...NODE_ARGS, '--config', configPath, '--port', String(PORT), '--host', '127.0.0.1', '--state-dir', stateDir, '--no-web', '--hot-reload'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const collect = (data: unknown) => {
    log += String(data)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const deadline = Date.now() + 30_000
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`gateway did not come up within 30s\n${log}`)
    }
    try {
      if ((await fetch(`${base}/sessions`)).ok) {
        return
      }
    } catch {}
    await sleep(200)
  }
}

// The engine child's pid surviving the swap is the claim this whole feature makes. Matched by command, not by
// "every child of the gateway": `caffeinate` is one of those too, and the wake lock is deliberately released and
// retaken per generation, so an all-children check reports the feature broken every single time.
function engineChildren(): string[] {
  try {
    return execFileSync('pgrep', ['-lP', String(child?.pid)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((entry) => /claude|codex/.test(entry))
      .map((entry) => entry.split(' ')[0]!)
  } catch {
    return []
  }
}

type Attached = {
  send: (text: string) => void
  close: () => void
  events: SessionEvent[]
  turnEnded: () => Promise<void>
  textSince: (mark: number) => string
}

async function attach(id: string, afterSeq = 0): Promise<Attached> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/sessions/${id}/ws?afterSeq=${afterSeq}`)
  const events: SessionEvent[] = []
  let resolveTurn: (() => void) | undefined
  ws.on('error', () => {})
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame
    if (frame.type !== 'event') {
      return
    }
    events.push(frame.event)
    if (frame.event.type === 'turn_result') {
      resolveTurn?.()
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    send: (text) => ws.send(JSON.stringify({ type: 'user_message', text })),
    close: () => ws.close(),
    events,
    turnEnded: () =>
      new Promise<void>((resolve) => {
        resolveTurn = resolve
        setTimeout(resolve, 180_000)
      }),
    textSince: (mark) =>
      events
        .slice(mark)
        .flatMap((event) =>
          event.type === 'assistant_message' && Array.isArray(event.message.content)
            ? event.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
            : [],
        )
        .join('')
        .trim(),
  }
}

function reload(): void {
  execFileSync(process.execPath, [...NODE_ARGS, 'reload', '--state-dir', stateDir], { stdio: 'pipe' })
}

async function main(): Promise<void> {
  console.log(`\n\u001b[1mHot reload, end to end\u001b[0m - port ${PORT}`)
  console.log(`\u001b[2mstate ${stateDir}\u001b[0m`)

  step('1. A gateway that can swap its own code, and a turn in flight')
  await startGateway()
  const created = await api<{ session: SessionInfo }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd: workDir, profile: 'claude', model: 'haiku', permissionMode: 'bypassPermissions' }),
  })
  const id = created.session.id
  ok('session created', id)

  const first = await attach(id)
  const ended = first.turnEnded()
  first.send(
    `Remember the word ${WORD}. Then use the Bash tool yourself (never the Task tool) to run exactly: ` +
      '`for i in $(seq 1 8); do echo "tick $i"; sleep 2; done` and reply with the last line of its output.',
  )
  // Long enough for the tool call to be dispatched and the shell to be counting, short enough to be inside it.
  await sleep(12_000)
  const gatewayPid = child?.pid
  const before = engineChildren()
  if (before.length > 0) {
    ok('an engine child is running under the gateway', before.join(' '))
  } else {
    bad('an engine child is running under the gateway', 'nothing to carry - the rest proves nothing')
  }

  step('2. The swap, mid-turn')
  first.close()
  const generations = log.split('reloaded on').length - 1
  reload()
  await sleep(2_000)
  if (log.split('reloaded on').length - 1 === generations + 1) {
    ok('the gateway reported a new generation', log.trim().split('\n').at(-1))
  } else {
    bad('the gateway reported a new generation', 'no reload line in the log')
  }
  if (child?.pid === gatewayPid && child?.exitCode === null) {
    ok('the gateway process is the same one', String(gatewayPid))
  } else {
    bad('the gateway process is the same one', 'it restarted, which is the thing this replaces')
  }
  const after = engineChildren()
  if (before.every((pid) => after.includes(pid))) {
    ok('the engine child survived the swap', after.join(' '))
  } else {
    bad('the engine child survived the swap', `${before.join(' ')} -> ${after.join(' ')}`)
  }

  step('3. The turn that spanned it, and the conversation behind it')
  const second = await attach(id, 0)
  await ended
  const finished = second.textSince(0)
  if (/tick 8/.test(finished)) {
    ok('the tool call that spanned the reload returned its real output')
  } else {
    bad('the tool call that spanned the reload returned its real output', JSON.stringify(finished.slice(0, 80)))
  }
  const mark = second.events.length
  const recall = second.turnEnded()
  second.send('What word did I ask you to remember? Reply with just that word.')
  await recall
  const answer = second.textSince(mark)
  if (answer.includes(WORD)) {
    ok('the carried session is the same conversation', JSON.stringify(answer.slice(0, 40)))
  } else {
    bad('the carried session is the same conversation', JSON.stringify(answer.slice(0, 80)))
  }
  second.close()

  console.log(`\n${fail === 0 ? '\u001b[32m' : '\u001b[31m'}${pass} passed, ${fail} failed\u001b[0m`)
  console.log(`\u001b[2mstate left at ${root}\u001b[0m`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    fail++
  })
  .finally(() => {
    child?.kill('SIGKILL')
    process.exit(fail === 0 ? 0 : 1)
  })

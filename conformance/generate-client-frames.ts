import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SessionHandle, type WorkerDeckClient } from '@workerdeck/client'
import { PROTOCOL_VERSION, SHELL_INPUT_MAX } from '@workerdeck/protocol'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'crates', 'core', 'tests', 'client-frames')

const REFUSAL =
  'This client cannot execute bridged tool calls: it has no sandbox. Run the tool server-side, or attach a browser client to host it.'

type Call = [string, ...unknown[]]

const CALLS: Call[] = [
  ['send', 'hello'],
  ['send', 'with pictures', ['att_1', 'att_2']],
  ['send', 'no pictures', []],
  ['approve', 'r1'],
  ['approve', 'r2', { command: 'ls -la', nested: { list: [1, 2.5, 'three'], flag: true, none: null } }],
  ['deny', 'r3'],
  ['deny', 'r4', 'no'],
  ['deny', 'r5', 'stop', true],
  ['interrupt'],
  ['clearContext'],
  ['sleep'],
  ['backgroundTask'],
  ['backgroundTask', 'tu1'],
  ['runShell', 'git status'],
  ['attachShell', 'sh_1', { cols: 80, rows: 24 }],
  ['writeShell', 'sh_1', 'ls -la\r'],
  ['writeShell', 'sh_1', 'café あ \u{1f600}'],
  ['writeShell', 'sh_1', 'x'.repeat(SHELL_INPUT_MAX * 2 + 10)],
  ['writeShell', 'sh_1', 'a'.repeat(SHELL_INPUT_MAX - 3) + '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}' + 'b'.repeat(8)],
  ['writeShell', 'sh_1', '\u00e9'.repeat(SHELL_INPUT_MAX)],
  ['resizeShell', 'sh_1', { cols: 100, rows: 30 }],
  ['detachShell', 'sh_1'],
  ['setPermissionMode', 'default'],
  ['setPermissionMode', 'acceptEdits'],
  ['setPermissionMode', 'bypassPermissions'],
  ['setPermissionMode', 'plan'],
  ['setPermissionMode', 'dontAsk'],
  ['setPermissionMode', 'auto'],
  ['setModel', 'opus'],
  ['setModel'],
  ['setEffort', 'xhigh'],
  ['setEffort'],
  ['sendToolCallError', 'exec_1', 'unsupported', REFUSAL],
  ['closeSession'],
]

async function framesFor([name, ...args]: Call): Promise<unknown[]> {
  const sent: string[] = []
  const socket = { readyState: 1, send: (payload: string) => sent.push(payload), close: () => {} }
  const client = { openSocket: () => socket } as unknown as WorkerDeckClient
  const handle = new SessionHandle(client, 's1', { reconnect: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const method = (handle as unknown as Record<string, (...rest: unknown[]) => void>)[name]
  method.apply(handle, args)
  handle.detach()
  return sent.map((payload) => JSON.parse(payload) as unknown)
}

const calls = []
for (const call of CALLS) {
  const [name, ...args] = call
  calls.push({ call: name, args, frames: await framesFor(call) })
}

const file = join(OUT, 'commands.json')
const body = `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, shellInputMax: SHELL_INPUT_MAX, calls }, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (!existsSync(file) || readFileSync(file, 'utf8') !== body) {
    process.stderr.write('Client frame goldens are stale.\nRun `pnpm fixtures:frames` and commit the result.\n')
    process.exit(1)
  }
  process.stdout.write(`${calls.length} client frame cases up to date\n`)
} else {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(file, body)
  process.stdout.write(`wrote ${calls.length} client frame goldens to ${OUT}\n`)
}

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const turns = Number(process.argv[2] ?? 80)

let seed = 0x2f6e2b1

function rand() {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 0x100000000
}

function pick(list) {
  return list[Math.floor(rand() * list.length)]
}

function int(lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1))
}

const WORDS = (
  'the reducer folds every event into a row and the planner wraps each row into lines so the height ' +
  'book can answer offsets without measuring text twice while streaming tokens arrive at the tail of the ' +
  'transcript and a long session must stay smooth on a phone even after thousands of tool calls'
).split(' ')
const IDENTS = ['applyEvent', 'TranscriptState', 'TerminalRows', 'VTScreen', 'heightBook', 'planLines', 'seq', 'replayHold']

function sentence() {
  const n = int(6, 18)
  const out = []
  for (let i = 0; i < n; i++) {
    const r = rand()
    if (r < 0.06) {
      out.push(`**${pick(WORDS)}**`)
    } else if (r < 0.12) {
      out.push(`\`${pick(IDENTS)}\``)
    } else {
      out.push(pick(WORDS))
    }
  }
  const s = out.join(' ')
  return s[0].toUpperCase() + s.slice(1) + '.'
}

function markdown() {
  const parts = []
  const blocks = int(2, 5)
  for (let b = 0; b < blocks; b++) {
    const r = rand()
    if (r < 0.2) {
      parts.push(`## ${sentence().slice(0, 40)}`)
    }
    if (r < 0.45) {
      parts.push(Array.from({ length: int(2, 5) }, () => `- ${sentence()}`).join('\n'))
    } else if (r < 0.6) {
      parts.push(
        '```ts\n' + Array.from({ length: int(3, 12) }, (_, i) => `const v${i} = ${pick(IDENTS)}(state, ${i})`).join('\n') + '\n```',
      )
    } else {
      parts.push(Array.from({ length: int(1, 4) }, sentence).join(' '))
    }
  }
  return parts.join('\n\n')
}

function codeFile(lines) {
  return Array.from(
    { length: lines },
    (_, i) => `${String(i + 1).padStart(5)}\t  ${pick(['const', 'let', 'return', 'if (', '//'])} ${pick(IDENTS)} = ${pick(WORDS)}(${i})`,
  ).join('\n')
}

let seq = 0
let ts = 1_760_000_000_000
let uid = 0
const frames = []

function id(p) {
  return `${p}-${++uid}`
}

function emit(body) {
  seq += 1
  ts += int(5, 120)
  frames.push(JSON.stringify({ type: 'event', event: { seq, ts, ...body } }))
}

function streamText(text, parent = null) {
  const uuid = id('a')
  let i = 0
  let d = 0
  while (i < text.length) {
    const n = int(2, 7)
    emit({
      type: 'stream_delta',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + n) } },
      parentToolUseId: parent,
      uuid: `${uuid}:d${d++}`,
    })
    i += n
  }
  return uuid
}

function assistant(content, uuid = id('a'), parent = null) {
  emit({ type: 'assistant_message', message: { role: 'assistant', content }, parentToolUseId: parent, uuid })
}

const TOOLS = [
  () => ['Read', { file_path: `/repo/packages/core/src/${pick(IDENTS)}.ts` }, codeFile(int(40, 260))],
  () => [
    'Bash',
    { command: `pnpm --filter @workerdeck/${pick(['core', 'react', 'ui'])} test`, description: 'Run the package tests' },
    Array.from({ length: int(10, 80) }, () => ` ✓ ${sentence()} (${int(1, 90)}ms)`).join('\n'),
  ],
  () => [
    'Grep',
    { pattern: pick(IDENTS), path: '/repo/packages' },
    Array.from(
      { length: int(5, 40) },
      (_, i) => `/repo/packages/${pick(['core', 'ui', 'react'])}/src/f${i}.ts:${int(1, 900)}: ${sentence()}`,
    ).join('\n'),
  ],
  () => [
    'Edit',
    { file_path: `/repo/packages/ui/src/${pick(IDENTS)}.tsx`, old_string: sentence(), new_string: sentence() },
    'The file has been updated successfully.',
  ],
]

emit({
  type: 'system_init',
  sdkSessionId: 'sdk-spike',
  model: 'claude-opus-5-5',
  cwd: '/repo',
  apiKeySource: 'none',
  tools: ['Read', 'Bash', 'Grep', 'Edit'],
  skills: [],
  slashCommands: [],
  permissionMode: 'default',
  claudeCodeVersion: '3.0.0',
  mcpServers: [],
})
for (let t = 0; t < turns; t++) {
  emit({ type: 'user_message', message: { role: 'user', content: `Turn ${t}: ${sentence()}` }, parentToolUseId: null, uuid: id('u') })
  emit({ type: 'status_changed', status: 'running' })
  assistant([{ type: 'thinking', thinking: Array.from({ length: int(2, 6) }, sentence).join(' ') }], id('t'))
  const steps = int(1, 4)
  for (let s = 0; s < steps; s++) {
    const text = markdown()
    const uuid = streamText(text)
    const [name, input, output] = pick(TOOLS)()
    const toolId = id('toolu')
    assistant(
      [
        { type: 'text', text },
        { type: 'tool_use', id: toolId, name, input },
      ],
      uuid,
    )
    emit({
      type: 'user_message',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: output }] },
      parentToolUseId: null,
      synthetic: true,
      uuid: `${toolId}:result`,
    })
  }
  const final = markdown()
  const uuid = streamText(final)
  assistant([{ type: 'text', text: final }], uuid)
  emit({
    type: 'turn_result',
    subtype: 'success',
    isError: false,
    durationMs: int(4000, 90000),
    numTurns: steps + 1,
    totalCostUsd: rand() / 5,
  })
  emit({ type: 'status_changed', status: 'idle' })
  emit({ type: 'context_usage', usage: { categories: [], totalTokens: 2000 * (t + 1), maxTokens: 1_000_000, percentage: 0.2 * (t + 1) } })
}
writeFileSync(join(here, 'session.jsonl'), frames.join('\n') + '\n')

const ESC = '\u001b'
const colors = [31, 32, 33, 34, 35, 36, 90]
const shell = []
for (let block = 0; block < 400; block++) {
  const r = rand()
  if (r < 0.3) {
    for (let i = 0; i < int(5, 30); i++) {
      shell.push(`${ESC}[${pick(colors)}m${pick(IDENTS).padEnd(18)}${ESC}[0m ${ESC}[1m${int(1, 99999)}${ESC}[22m ${sentence()}\r\n`)
    }
  } else if (r < 0.5) {
    for (let p = 0; p <= 100; p += int(3, 12)) {
      shell.push(`\r${ESC}[2K[${'#'.repeat(p / 4).padEnd(25)}] ${p}% ${pick(IDENTS)}`)
    }
    shell.push('\r\n')
  } else if (r < 0.65) {
    shell.push(`${ESC}[s${ESC}[1;1H${ESC}[7m status ${block} ${ESC}[0m${ESC}[u`)
    shell.push(`${ESC}[38;5;${int(16, 231)}m${sentence()}${ESC}[39m\r\n`)
  } else if (r < 0.75) {
    shell.push(`${ESC}[38;2;${int(0, 255)};${int(0, 255)};${int(0, 255)}m│ ${sentence()} │ éü 中文 🚀${ESC}[0m\r\n`)
  } else {
    shell.push(`${sentence()} ${sentence()} ${sentence()}\r\n`)
  }
}
writeFileSync(join(here, 'shell.txt'), shell.join(''))
console.log(`session.jsonl: ${frames.length} frames, shell.txt: ${shell.join('').length} chars`)

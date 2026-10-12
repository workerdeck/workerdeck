import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SessionEvent } from '@workerdeck/protocol'

import { projectTranscript } from '../packages/react/src/lib/transcript-projection.ts'
import { applyEvent, initialTranscriptState } from '../packages/react/src/lib/transcript.ts'
import { CORPUS, DUPLICATES, type Case } from './corpus.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'crates', 'core', 'tests', 'conformance')
const EPOCH = 1_760_000_000_000

function eventsOf(entry: Case): SessionEvent[] {
  const events: SessionEvent[] = []
  let ts = EPOCH
  for (const cue of entry.tape) {
    ts += cue.gap
    if ('event' in cue) {
      events.push({ ...cue.event, seq: events.length + 1, ts } as SessionEvent)
    }
  }
  return DUPLICATES.has(entry.name) ? [...events, ...events] : events
}

function render(entry: Case): Map<string, string> {
  const events = eventsOf(entry)
  const state = events.reduce(applyEvent, initialTranscriptState)
  const frames = events.map((event) => JSON.stringify({ type: 'event', event })).join('\n')
  return new Map([
    [`${entry.name}.events.jsonl`, `${frames}\n`],
    [`${entry.name}.projection.json`, `${JSON.stringify(projectTranscript(state), null, 2)}\n`],
  ])
}

const check = process.argv.includes('--check')
const wanted = new Map<string, string>()
for (const entry of CORPUS) {
  for (const [file, body] of render(entry)) {
    wanted.set(file, body)
  }
}

const existing = existsSync(OUT) ? readdirSync(OUT).filter((file) => file.endsWith('.jsonl') || file.endsWith('.json')) : []
const stale = [...wanted]
  .filter(([file, body]) => !existsSync(join(OUT, file)) || readFileSync(join(OUT, file), 'utf8') !== body)
  .map(([file]) => file)
const orphans = existing.filter((file) => !wanted.has(file))

if (check) {
  if (stale.length > 0 || orphans.length > 0) {
    process.stderr.write(
      `Conformance goldens are stale: ${[...stale, ...orphans].join(', ')}\nRun \`pnpm fixtures:golden\` and commit the result.\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`${CORPUS.length} conformance cases up to date\n`)
} else {
  mkdirSync(OUT, { recursive: true })
  for (const file of orphans) {
    rmSync(join(OUT, file))
  }
  for (const file of stale) {
    writeFileSync(join(OUT, file), wanted.get(file)!)
  }
  process.stdout.write(`${CORPUS.length} cases, ${stale.length} files written, ${orphans.length} removed\n`)
}

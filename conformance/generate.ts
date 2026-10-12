import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SessionEvent } from '@workerdeck/protocol'

import { recapLine, summarizeSince } from '../packages/react/src/lib/recap.ts'
import { projectTranscript } from '../packages/react/src/lib/transcript-projection.ts'
import { applyEvent, initialTranscriptState } from '../packages/react/src/lib/transcript.ts'
import { CORPUS, DUPLICATES, type Case } from './corpus.ts'
import { VT_CORPUS } from './vt-corpus.ts'

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
    [`${entry.name}.recap.json`, `${JSON.stringify(recaps(state), null, 2)}\n`],
  ])
}

function recaps(state: typeof initialTranscriptState): unknown[] {
  return Array.from({ length: state.items.length + 1 }, (_, boundary) => {
    const pending = boundary % 3
    const summary = summarizeSince({ items: state.items, pendingApprovals: Array.from({ length: pending }) }, boundary)
    return { boundary, pending, summary, line: recapLine(summary) ?? null }
  })
}

const OWNED = /(\.events\.jsonl|\.projection\.json|\.recap\.json|\.vt\.json)$/

const check = process.argv.includes('--check')
const wanted = new Map<string, string>()
for (const entry of CORPUS) {
  for (const [file, body] of render(entry)) {
    wanted.set(file, body)
  }
}
for (const entry of VT_CORPUS) {
  wanted.set(`vt-${entry.name}.vt.json`, `${JSON.stringify(entry, null, 2)}\n`)
}

const existing = existsSync(OUT) ? readdirSync(OUT).filter((file) => OWNED.test(file)) : []
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
  process.stdout.write(`${CORPUS.length + VT_CORPUS.length} conformance cases up to date\n`)
} else {
  mkdirSync(OUT, { recursive: true })
  for (const file of orphans) {
    rmSync(join(OUT, file))
  }
  for (const file of stale) {
    writeFileSync(join(OUT, file), wanted.get(file)!)
  }
  process.stdout.write(`${CORPUS.length + VT_CORPUS.length} cases, ${stale.length} files written, ${orphans.length} removed\n`)
}

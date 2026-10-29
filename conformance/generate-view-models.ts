import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as protocol from '@workerdeck/protocol'
import type { CustomGroup, SessionTask, ViewConfig, Watermark } from '@workerdeck/protocol'

import {
  applyEvent,
  hydrateShellOutput,
  hydrateShellRow,
  hydrateToolResult,
  initialTranscriptState,
  seedFromSessionInfo,
  type TranscriptState,
} from '../packages/react/src/lib/transcript.ts'
import { projectTranscript } from '../packages/react/src/lib/transcript-projection.ts'
import { permissionPromptModel } from '../packages/ui/src/lib/permission-prompt.ts'
import { shellRequestLines } from '../packages/ui/src/lib/shell-request.ts'
import { faceStateOf, faceSvg, type FaceSvgOptions } from '../packages/ui/src/lib/face-svg.ts'
import { answerFor, EMPTY_SELECTION, toggleLabel, toggleOther, type Selection } from '../packages/ui/src/lib/question-answers.ts'
import { caseEvents } from './corpus.ts'
import { VM_CORPUS } from './view-models.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'crates', 'core', 'tests', 'view-models')

type Fn = (...args: never[]) => unknown

function customGroupScript(groups: CustomGroup[], [op, a, b, c]: [string, string, unknown, unknown]): unknown {
  switch (op) {
    case 'add': {
      return protocol.addCustomGroup(groups, a, b as string)
    }
    case 'rename': {
      return protocol.renameCustomGroup(groups, a, b as string)
    }
    case 'remove': {
      return protocol.removeCustomGroup(groups, a)
    }
    case 'moveTo': {
      return protocol.moveToCustomGroup(groups, a, b as string | undefined, c as string | undefined)
    }
    case 'move': {
      return protocol.moveCustomGroup(groups, a, b as string | undefined)
    }
    default: {
      return protocol.styleCustomGroup(groups, a, b as { color?: string | null; icon?: string | null })
    }
  }
}

function filterEngagement(config: ViewConfig) {
  return {
    hasFacetFilter: protocol.hasFacetFilter(config),
    facetFilterCount: protocol.facetFilterCount(config),
    displayCustomized: protocol.displayCustomized(config),
  }
}

function watermarkScript(initial: Record<string, Watermark>, ops: unknown[][]) {
  const writes: Record<string, Watermark>[] = []
  const marks = new protocol.Watermarks({ read: () => initial, write: (next) => writes.push(structuredClone(next)) })
  const results = ops.map(([op, host, session, seen, now]) => {
    const before = writes.length
    if (op === 'mark') {
      return marks.mark(host as string, session as string, seen as Parameters<protocol.Watermarks['mark']>[2], now as number)
    }
    marks.forget(host as string, session as string)
    return writes.length > before
  })
  return { results, writes, marks: marks.all() }
}

// One reducer story: replays a conformance case's events, seeds an attach snapshot, hydrates. The Rust side reads the
// same events from the conformance goldens, so a case name is all a call carries.
function transcriptScript(ops: unknown[][]) {
  let state: TranscriptState = initialTranscriptState
  for (const [op, a, b] of ops) {
    if (op === 'events') {
      state = caseEvents(a as string).reduce(applyEvent, state)
    } else if (op === 'effort') {
      state = applyEvent(state, { type: 'effort_changed', effort: a as string | null, seq: state.lastSeq + 1, ts: 1 } as protocol.SessionEvent)
    } else if (op === 'seed') {
      state = seedFromSessionInfo(state, a as protocol.SessionInfo)
    } else if (op === 'hydrateResult') {
      state = hydrateToolResult(state, a as string, b as string)
    } else if (op === 'hydrateShell') {
      state = hydrateShellRow(state, a as string, (b ?? undefined) as protocol.ShellInfo | undefined)
    } else {
      state = hydrateShellOutput(state, a as string, b as string)
    }
  }
  return projectTranscript(state)
}

// A question's selection through a run of taps: each step reports the selection and the answer it reads as.
function selectionScript(multiSelect: boolean, ops: [string, string?][]) {
  let selection: Selection = EMPTY_SELECTION
  return ops.map(([op, value]) => {
    if (op === 'label') {
      selection = toggleLabel(selection, value!, multiSelect)
    } else if (op === 'other') {
      selection = toggleOther(selection, multiSelect)
    } else {
      selection = { ...selection, other: value! }
    }
    return { selection, answer: answerFor(selection) }
  })
}

function taskScript(info: Parameters<typeof protocol.sessionTasks>[0]) {
  const tasks: SessionTask[] = protocol.sessionTasks(info)
  const summary = protocol.taskSummary(tasks)
  return {
    summary,
    label: protocol.taskCountLabel(summary) ?? null,
    hidden: protocol.visibleTasks(tasks, false),
    shown: protocol.visibleTasks(tasks, true),
  }
}

type FaceNode = { tag: string; attrs: Record<string, unknown>; children: FaceNode[] }

const PATH_NUMBER = /-?(?:\d+\.?\d*|\.\d+)/g

// A path's `d` as absolute M, L, Q and Z segments, so both sides compare geometry, not spelling.
function absolutePath(d: string): unknown[][] {
  const out: unknown[][] = []
  let [x, y, sx, sy] = [0, 0, 0, 0]
  let control: [number, number] | undefined
  for (const [, op, body] of d.matchAll(/([MmLlHhVvQqTtZz])([^MmLlHhVvQqTtZz]*)/g)) {
    const n = (body!.match(PATH_NUMBER) ?? []).map(Number)
    const rel = op === op!.toLowerCase()
    const upper = op!.toUpperCase()
    if (upper === 'Z') {
      out.push(['Z'])
      ;[x, y] = [sx, sy]
      control = undefined
      continue
    }
    const step = { M: 2, L: 2, H: 1, V: 1, Q: 4, T: 2 }[upper]!
    for (let i = 0; i < n.length; i += step) {
      const a = n.slice(i, i + step)
      if (upper === 'H') {
        x = rel ? x + a[0]! : a[0]!
        out.push(['L', x, y])
        control = undefined
      } else if (upper === 'V') {
        y = rel ? y + a[0]! : a[0]!
        out.push(['L', x, y])
        control = undefined
      } else if (upper === 'Q') {
        const c: [number, number] = rel ? [x + a[0]!, y + a[1]!] : [a[0]!, a[1]!]
        ;[x, y] = rel ? [x + a[2]!, y + a[3]!] : [a[2]!, a[3]!]
        out.push(['Q', c[0], c[1], x, y])
        control = c
      } else if (upper === 'T') {
        const c: [number, number] = control ? [2 * x - control[0], 2 * y - control[1]] : [x, y]
        ;[x, y] = rel ? [x + a[0]!, y + a[1]!] : [a[0]!, a[1]!]
        out.push(['Q', c[0], c[1], x, y])
        control = c
      } else {
        ;[x, y] = rel ? [x + a[0]!, y + a[1]!] : [a[0]!, a[1]!]
        const move = upper === 'M' && i === 0
        out.push([move ? 'M' : 'L', x, y])
        if (move) {
          ;[sx, sy] = [x, y]
        }
        control = undefined
      }
    }
  }
  return out
}

function faceAttr(name: string, value: string): unknown {
  if (name === 'd') {
    return absolutePath(value)
  }
  if (name === 'style') {
    return Object.fromEntries(
      value.split(';').filter(Boolean).map((decl) => {
        const [key, raw] = decl.split(':') as [string, string]
        const shift = /^translateY\((.+)px\)$/.exec(raw)
        return shift ? ['translateY', Number(shift[1])] : [key, Number(raw.replace(/s$/, ''))]
      }),
    )
  }
  return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : value
}

// The face's SVG read back as a tree; the Rust renderer builds the same tree before lowering it to draw ops.
function faceTree(options: FaceSvgOptions): FaceNode {
  const root: FaceNode = { tag: '', attrs: {}, children: [] }
  const stack = [root]
  for (const [, close, tag, attrs, selfClose] of faceSvg(options).matchAll(/<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"]*")*)\s*(\/?)>/g)) {
    if (close) {
      stack.pop()
      continue
    }
    const node: FaceNode = {
      tag: tag!,
      attrs: Object.fromEntries([...attrs!.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map(([, k, v]) => [k!, faceAttr(k!, v!)])),
      children: [],
    }
    stack.at(-1)!.children.push(node)
    if (!selfClose) {
      stack.push(node)
    }
  }
  return root.children[0]!
}

const FNS: Record<string, Fn> = {
  ...(protocol as unknown as Record<string, Fn>),
  customGroupScript,
  filterEngagement,
  watermarkScript,
  taskScript,
  transcriptScript,
  permissionPromptModel,
  shellRequestLines,
  selectionScript,
  faceTree,
  faceStateOf,
  defaultPricing: () => protocol.DEFAULT_PRICING,
  meteredCostOf: (byModel: protocol.ByModel) => protocol.meteredCost(protocol.costOfByModel(byModel)),
  pricingAge: (now: number, asOf?: string) => ({ days: protocol.pricingAgeDays(now, asOf), note: protocol.pricingAgeNote(now, asOf) ?? null }),
  newAgentDefaults: (defaults?: protocol.GatewayAgentDefaults, profile?: protocol.ProfileInfo) => ({
    owner: protocol.newAgentOwner(defaults, profile) ?? null,
    sharing: protocol.newAgentSharing(defaults, profile),
  }),
}

function render(fn: string, calls: unknown[][]): string {
  const run = FNS[fn]
  if (typeof run !== 'function') {
    throw new Error(`no view-model function ${fn}`)
  }
  const output = calls.map((args) => run(...(args as never[])) ?? null)
  return `${JSON.stringify({ input: { fn, calls }, output }, null, 2)}\n`
}

const check = process.argv.includes('--check')
const wanted = new Map(VM_CORPUS.map((entry) => [`${entry.module}.${entry.name}.json`, render(entry.fn, entry.calls)]))
const existing = existsSync(OUT) ? readdirSync(OUT).filter((file) => file.endsWith('.json')) : []
const stale = [...wanted]
  .filter(([file, body]) => !existsSync(join(OUT, file)) || readFileSync(join(OUT, file), 'utf8') !== body)
  .map(([file]) => file)
const orphans = existing.filter((file) => !wanted.has(file))

if (check) {
  if (stale.length > 0 || orphans.length > 0) {
    process.stderr.write(`View-model goldens are stale: ${[...stale, ...orphans].join(', ')}\nRun \`pnpm fixtures:vm\` and commit the result.\n`)
    process.exit(1)
  }
  process.stdout.write(`${VM_CORPUS.length} view-model cases up to date\n`)
} else {
  mkdirSync(OUT, { recursive: true })
  for (const file of orphans) {
    rmSync(join(OUT, file))
  }
  for (const file of stale) {
    writeFileSync(join(OUT, file), wanted.get(file)!)
  }
  process.stdout.write(`${VM_CORPUS.length} view-model cases, ${stale.length} files written, ${orphans.length} removed\n`)
}

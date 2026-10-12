import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as protocol from '@workerdeck/protocol'
import type { CustomGroup, SessionTask, ViewConfig, Watermark } from '@workerdeck/protocol'

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

const FNS: Record<string, Fn> = {
  ...(protocol as unknown as Record<string, Fn>),
  customGroupScript,
  filterEngagement,
  watermarkScript,
  taskScript,
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

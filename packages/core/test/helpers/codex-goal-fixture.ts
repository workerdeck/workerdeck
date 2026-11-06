import { readFileSync } from 'node:fs'
import type { AppServerThreadGoal } from '../../src/engines/codex/types.ts'
import type { ScriptedPeer } from './codex-peer.ts'

// Wire logs recorded against the real `codex app-server` 0.166.0 (goal spike), trimmed and scrubbed; ids renamed
// to `thread-1`, `turn-N`, `item-N`.
export type GoalFixtureLine = { t: number; dir: '->' | '<-'; kind: 'req' | 'res' | 'note'; method: string; body: any }

export function goalFixture(name: string): GoalFixtureLine[] {
  const url = new URL(`../fixtures/goals/codex-0.166.0/${name}.jsonl`, import.meta.url)
  return readFileSync(url, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GoalFixtureLine)
}

export function fixtureGoals(lines: GoalFixtureLine[]): AppServerThreadGoal[] {
  return lines.flatMap((line) => (line.body?.goal ? [line.body.goal as AppServerThreadGoal] : []))
}

// Replays a fixture against the runner's requests. A request the fixture records is answered in recorded order: the
// notifications between it and its response arrive first, as on the wire, and the ones after it follow a macrotask
// later (or at `notes()`). `rest(stop)` plays notifications past spike-only requests the runner never sends, up to the
// request named `stop`.
// A request the fixture lacks goes to `extra`.
export function playFixture(peer: ScriptedPeer, lines: GoalFixtureLine[], extra: Record<string, (params: unknown) => unknown> = {}) {
  let at = 0
  const emitNote = (line: GoalFixtureLine): void => {
    if (line.kind === 'note') {
      peer.emit(line.method, line.body)
    }
  }
  const notes = (): void => {
    while (at < lines.length && lines[at]!.dir !== '->') {
      emitNote(lines[at]!)
      at++
    }
  }
  const rest = (stop?: string): void => {
    for (; at < lines.length && !(lines[at]!.dir === '->' && lines[at]!.method === stop); at++) {
      emitNote(lines[at]!)
    }
  }
  const methods = new Set([...lines.filter((line) => line.dir === '->').map((line) => line.method), ...Object.keys(extra)])
  for (const method of methods) {
    peer.respond(method, (params) => {
      const index = lines.findIndex((line, i) => i >= at && line.dir === '->' && line.method === method)
      if (index < 0) {
        const fallback = extra[method]
        if (!fallback) {
          throw new Error(`fixture has no further ${method}`)
        }
        return fallback(params)
      }
      for (; at < index; at++) {
        emitNote(lines[at]!)
      }
      at = index + 1
      while (at < lines.length && !(lines[at]!.kind === 'res' && lines[at]!.method === method)) {
        emitNote(lines[at]!)
        at++
      }
      setTimeout(notes, 0)
      return lines[at++]?.body
    })
  }
  return { notes, rest, done: () => at >= lines.length }
}

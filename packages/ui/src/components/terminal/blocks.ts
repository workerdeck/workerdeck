import type { TranscriptItem } from '@workerdeck/react'
import { foldsTogether } from './tool-run.ts'

export type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

// `user` items carry `parentToolUseId` only optionally (only a subagent's brief has the key); the other kinds carry it as `string | null`.
export const parentOf = (item: TranscriptItem): string | undefined => {
  const parent = 'parentToolUseId' in item ? item.parentToolUseId : undefined
  return parent ?? undefined
}

export const subagentItems = (items: readonly TranscriptItem[], parentToolUseId: string): TranscriptItem[] => {
  return items.filter((item) => parentOf(item) === parentToolUseId)
}

export const isRunCall = (item: TranscriptItem): item is ToolCallItem => {
  return item.kind === 'tool_call'
}

export type ItemBlock = { key: string; item: TranscriptItem; index: number }
export type RunBlock = {
  key: string
  run: ToolCallItem[]
  indices: number[]
  index: number
}
export type LeafBlock = ItemBlock | RunBlock

export type TaskBlock = {
  key: string
  task: ToolCallItem
  children: LeafBlock[]
  childIndices: number[]
  index: number
}

export type TerminalBlock = ItemBlock | RunBlock | TaskBlock

export const taskChildItems = (block: TaskBlock): TranscriptItem[] => {
  return block.children.flatMap((child) => ('run' in child ? child.run : [child.item]))
}

const pushLeaf = (out: LeafBlock[], item: TranscriptItem, index: number): void => {
  const previous = out.at(-1)
  if (isRunCall(item)) {
    if (previous && 'run' in previous && foldsTogether(previous.run[0]!, item)) {
      previous.run.push(item)
      previous.indices.push(index)
    } else {
      out.push({ key: `run:${item.id}`, run: [item], indices: [index], index })
    }
    return
  }
  out.push({ key: `${item.kind}:${item.id}`, item, index })
}

export const terminalBlocks = (items: readonly TranscriptItem[], offset = 0, fold = true): TerminalBlock[] => {
  if (!fold) {
    return items.map((item, position) => ({
      key: `${item.kind}:${item.id}`,
      item,
      index: offset + position,
    }))
  }

  const topLevelCalls = new Set<string>()
  for (const item of items) {
    if (item.kind === 'tool_call' && parentOf(item) === undefined) {
      topLevelCalls.add(item.id)
    }
  }
  const childrenOf = new Map<string, { item: TranscriptItem; index: number }[]>()
  items.forEach((item, position) => {
    const parent = parentOf(item)
    if (parent !== undefined && topLevelCalls.has(parent)) {
      const list = childrenOf.get(parent)
      if (list) {
        list.push({ item, index: offset + position })
      } else {
        childrenOf.set(parent, [{ item, index: offset + position }])
      }
    }
  })

  const out: TerminalBlock[] = []
  for (const [position, item] of items.entries()) {
    const index = offset + position
    const parent = parentOf(item)
    if (parent !== undefined && childrenOf.has(parent)) {
      continue
    }
    if (item.kind === 'tool_call') {
      const children = childrenOf.get(item.id)
      if (children) {
        const folded: LeafBlock[] = []
        for (const child of children) {
          pushLeaf(folded, child.item, child.index)
        }
        out.push({
          key: `task:${item.id}`,
          task: item,
          children: folded,
          childIndices: children.map((child) => child.index),
          index,
        })
        continue
      }
    }
    pushLeaf(out as LeafBlock[], item, index)
  }
  return out
}

export const needsBlank = (previous: TranscriptItem, next: TranscriptItem): boolean => {
  if (previous.kind === 'tool_call' && next.kind === 'tool_call') {
    return false
  }
  return true
}

export const blockNeedsBlank = (previous: TerminalBlock, next: TerminalBlock): boolean => {
  const kind = (block: TerminalBlock) => ('item' in block ? block.item.kind : 'tool_call')
  return !(kind(previous) === 'tool_call' && kind(next) === 'tool_call')
}

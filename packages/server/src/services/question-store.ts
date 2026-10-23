import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QuestionItem } from '@workerdeck/protocol'
import { readJsonOrSync, writeJsonAtomicSync } from '../lib/atomic-file.ts'

export type StoredQuestionBoard = { id: string; next: number; items: QuestionItem[] }

export type QuestionStore = {
  list(): StoredQuestionBoard[]
  save(board: StoredQuestionBoard): void
}

export function createMemoryQuestionStore(seed: StoredQuestionBoard[] = []): QuestionStore {
  const boards = new Map(seed.map((board) => [board.id, structuredClone(board)]))
  return {
    list: () => [...boards.values()].map((board) => structuredClone(board)),
    save: (board) => {
      boards.set(board.id, structuredClone(board))
    },
  }
}

// One file per board, so a write rewrites only the board it touched.
export function createFileQuestionStore(dir: string): QuestionStore {
  return {
    list: () => {
      let names: string[]
      try {
        names = readdirSync(dir).filter((name) => name.endsWith('.json'))
      } catch {
        return []
      }
      return names.map((name) => readJsonOrSync(join(dir, name), undefined)).filter(isStoredBoard)
    },
    save: (board) => writeJsonAtomicSync(join(dir, `${encodeURIComponent(board.id)}.json`), board, { indent: 2 }),
  }
}

function isStoredBoard(value: unknown): value is StoredQuestionBoard {
  const board = value as Partial<StoredQuestionBoard> | null
  return typeof board?.id === 'string' && typeof board.next === 'number' && Array.isArray(board.items)
}

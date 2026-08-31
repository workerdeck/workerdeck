import { readJson, writeJson } from './storage.ts'

const KEY = 'workerdeck.rail'

export type Rail = { width: number; collapsed: boolean }

const DEFAULT: Rail = { width: 260, collapsed: false }

export function getRail(): Rail {
  const stored = readJson<Partial<Rail>>(KEY, {})
  return {
    width: Math.min(520, Math.max(180, Number(stored.width) || DEFAULT.width)),
    collapsed: stored.collapsed === true,
  }
}

export function setRail(rail: Rail): void {
  writeJson(KEY, rail)
}

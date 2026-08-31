import { useCallback, useState } from 'react'
import { DEFAULT_VIEW_CONFIG } from '@workerdeck/protocol'
import type { ViewConfig } from '@workerdeck/protocol'

const KEY = 'workerdeck.view-config'

// `search` always starts empty and `scoped` is forced off: a dashboard has no open folders for it to mean anything against.
export function useViewConfig() {
  const [config, setConfig] = useState<ViewConfig>(() => {
    try {
      const raw = localStorage.getItem(KEY)
      const stored = raw ? (JSON.parse(raw) as Partial<ViewConfig>) : {}
      return { ...DEFAULT_VIEW_CONFIG, ...stored, search: '', scoped: false }
    } catch {
      return { ...DEFAULT_VIEW_CONFIG, scoped: false }
    }
  })

  const update = useCallback((next: ViewConfig) => {
    setConfig(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {}
  }, [])

  return [config, update] as const
}

import { useCallback, useState } from 'react'
import { DEFAULT_VIEW_CONFIG } from '@workerdeck/protocol'
import type { ViewConfig } from '@workerdeck/protocol'

const KEY = 'workerdeck.view-config'

/**
 * The sessions list's filter/group/sort, remembered across visits.
 *
 * Two deliberate departures from the stored value: `search` always starts empty
 * — a search someone typed last week is a filter they will not remember setting
 * — and `scoped` is forced off, because a dashboard has no open folders for it
 * to mean anything against. Keeping the field rather than dropping it is what
 * lets one `ViewConfig` serve every client.
 */
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
    } catch {
      /* private mode — the choice still holds for this session */
    }
  }, [])

  return [config, update] as const
}

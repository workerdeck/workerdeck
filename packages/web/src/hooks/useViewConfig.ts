import { useCallback, useState } from 'react'
import { DEFAULT_VIEW_CONFIG } from '@workerdeck/protocol'
import type { ViewConfig } from '@workerdeck/protocol'
import { readJson, writeJson } from '../lib/storage.ts'

const KEY = 'workerdeck.view-config'

// `search` always starts empty and `scoped` is forced off: a dashboard has no open folders for it to mean anything against.
export function useViewConfig() {
  const [config, setConfig] = useState<ViewConfig>(() => ({
    ...DEFAULT_VIEW_CONFIG,
    ...readJson<Partial<ViewConfig>>(KEY, {}),
    search: '',
    scoped: false,
  }))

  const update = useCallback((next: ViewConfig) => {
    setConfig(next)
    writeJson(KEY, next)
  }, [])

  return [config, update] as const
}

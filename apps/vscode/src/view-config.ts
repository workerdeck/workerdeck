import { sessionState } from '@workerdeck/protocol'
import type { SessionRow } from '@workerdeck/protocol'
import type { SidebarState } from './bridge-protocol.ts'

/**
 * The sessions list's view model. The rules (state buckets, facets, filtering,
 * grouping, sorting, subset wording) live in `@workerdeck/protocol` so the
 * dashboard and iOS agree with us; only `buildRows` is ours. Re-exported here so
 * the sidebar's modules read as one view model.
 */
export {
  DEFAULT_VIEW_CONFIG,
  STATE_LABELS,
  STATE_ORDER,
  adaptersOf,
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  inScope,
  projectKey,
  projectLabel,
  projectSubpath,
  projectsOf,
  runningSubagents,
  scopeActive,
  sessionLabel,
  sessionState,
  subagentLabel,
  subsetSummary,
} from '@workerdeck/protocol'
export type { Facet, GroupBy, SessionGroup, SessionRow, SessionState, SortBy, SubsetSummary, ViewConfig } from '@workerdeck/protocol'

/** Every connected gateway's sessions, flattened. Recency order is preserved from
 * the model, so it survives as the tiebreak through every sort. */
export const buildRows = (state: SidebarState | undefined): SessionRow[] => {
  if (!state) {
    return []
  }
  const rows: SessionRow[] = []
  for (const host of state.hosts) {
    for (const info of state.sessions[host.id] ?? []) {
      rows.push({
        hostId: host.id,
        hostName: host.name,
        local: host.local,
        adapter: info.engine ?? 'claude',
        state: sessionState(info),
        info,
        unseen: state.unseen?.[`${host.id}:${info.id}`] ?? 0,
      })
    }
  }
  return rows
}

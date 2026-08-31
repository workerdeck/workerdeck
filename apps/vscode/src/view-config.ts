import { sessionState } from '@workerdeck/protocol'
import type { SessionRow } from '@workerdeck/protocol'
import type { SidebarState } from './bridge-protocol.ts'

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

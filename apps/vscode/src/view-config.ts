import { sessionState } from '@workerdeck/protocol'
import type { SessionRow } from '@workerdeck/protocol'
import type { SidebarState } from './bridge-protocol.ts'

/**
 * The sessions list's view model, as this extension sees it.
 *
 * The *rules* — the state buckets, the facets, filtering, grouping, sorting, the
 * subset wording — live in `@workerdeck/protocol` now, because more than this
 * extension needs them to agree: the dashboard renders the same list, and iOS
 * mirrors them in Swift. What stays here is the one thing that is genuinely
 * ours: turning the sidebar's bridge state into rows.
 *
 * Re-exported rather than imported directly by every call site so the sidebar's
 * modules keep reading as one view model.
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
  runningSubagents,
  scopeActive,
  sessionLabel,
  sessionState,
  subagentLabel,
  subsetSummary,
} from '@workerdeck/protocol'
export type {
  Facet,
  GroupBy,
  SessionGroup,
  SessionRow,
  SessionState,
  SortBy,
  SubsetSummary,
  ViewConfig,
} from '@workerdeck/protocol'

/** Every connected gateway's sessions, flattened. Recency order is preserved
 * from the model, so it survives as the tiebreak through every sort. */
export function buildRows(state: SidebarState | undefined): SessionRow[] {
  if (!state) return []
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

import type { SubsetSummary } from '../../src/view-config.ts'

/**
 * The one "you are seeing a subset" signal. Rendered whether or not the filter bar
 * is open: with the controls behind a title-bar toggle this line is all that stands
 * between a scoped-by-default list and "my sessions are gone".
 */
export function SubsetLine({ subset, onClear }: { subset: SubsetSummary; onClear: () => void }) {
  return (
    <div className="flex shrink-0 items-baseline gap-1.5 border-b border-border px-2 py-1 text-label text-fg-4">
      <span className="shrink-0 tabular-nums">
        {subset.shown} of {subset.total}
      </span>
      <span className="min-w-0 flex-1 truncate">· {subset.causes.join(' · ')}</span>
      <button type="button" onClick={onClear} className="shrink-0 underline-offset-2 hover:text-fg-1 hover:underline">
        Show all
      </button>
    </div>
  )
}

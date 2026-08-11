import type { SubsetSummary } from '../../src/view-config.ts'

/**
 * The one "you are seeing a subset" signal: how many of how many, what is doing
 * the hiding, and a single click to stop.
 *
 * **Unconditional** — it renders whether or not the filter bar is open, and that
 * is the point. The controls now live behind a title-bar toggle, so with them
 * closed this line is the only thing standing between a scoped-by-default list
 * and someone concluding their sessions are gone. It replaced two weaker
 * signals: a dot on the funnel and a folder-scope line, which competed with each
 * other and between them never said how many rows were missing.
 */
export function SubsetLine({
  subset,
  onClear,
}: {
  subset: SubsetSummary
  onClear: () => void
}) {
  return (
    <div className='flex shrink-0 items-baseline gap-1.5 border-b border-border px-2 py-1 text-label text-fg-4'>
      <span className='shrink-0 tabular-nums'>
        {subset.shown} of {subset.total}
      </span>
      <span className='min-w-0 flex-1 truncate'>· {subset.causes.join(' · ')}</span>
      <button
        type='button'
        onClick={onClear}
        className='shrink-0 underline-offset-2 hover:text-fg-1 hover:underline'>
        Show all
      </button>
    </div>
  )
}

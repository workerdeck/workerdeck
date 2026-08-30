import type { SessionRow } from '@workerdeck/protocol'
import { SessionItem, cn } from '@workerdeck/ui'
import { MoreHorizontal } from 'lucide-react'

/**
 * One session in the sidebar list — `packages/ui`'s `SessionItem`, plus the two
 * things that are genuinely extension-shaped: the overflow is a **native menu**
 * (a popover anchored in a sidebar this narrow would be clipped by the view's own
 * bounds), and rename is a double-click on the title. Colours come from
 * `styles.css` repointing the ui tokens at `--vscode-*`, so no VS Code variable is
 * named in here.
 */
export function SessionCard({
  row,
  showProject = true,
  showGateway,
  projectIcons,
  selected,
  activeSubagentId,
  onSelect,
  onSelectSubagent,
  onRevealStep,
  onRename,
  onMenu,
}: {
  row: SessionRow
  /** False when the list is already grouped by project — see `SessionItem`. */
  showProject?: boolean
  /** Shown when the list is not already grouped by gateway. */
  showGateway?: boolean
  /** Resolved project-icon bytes by content hash — see `ProjectIconCache`. */
  projectIcons?: Record<string, string>
  selected: boolean
  /** Which of this session's sub-agents the panel has framed, if any — the
   * finer of the two selections. See `SessionItem`. */
  activeSubagentId?: string
  onSelect: () => void
  /** Open the session *at* one of its sub-agents — see `wd-select-session`'s
   * `subagentToolUseId`. */
  onSelectSubagent: (toolUseId: string) => void
  /** Open the session and travel to a **task**'s row — see
   * `wd-select-session`'s `revealToolUseId`. Not a takeover: a task has no
   * agent behind it. */
  onRevealStep: (toolUseId: string) => void
  onRename: (title: string) => void
  /** Open the card's overflow menu. Native, host-side — see above. */
  onMenu: () => void
}) {
  return (
    <SessionItem
      row={row}
      active={selected}
      activeStepKey={activeSubagentId}
      showProject={showProject}
      showGateway={showGateway}
      projectIcons={projectIcons}
      onSelect={onSelect}
      onSelectSubagent={onSelectSubagent}
      onRevealStep={onRevealStep}
      onRename={onRename}
      actions={<CardMenu onOpen={onMenu} />}
    />
  )
}

/** The card's overflow. Always visible, not hover-revealed. */
function CardMenu({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Session actions"
      title="Session actions"
      onClick={(e) => {
        // The whole card is a button; this one does not mean "select".
        e.stopPropagation()
        onOpen()
      }}
      className={cn('flex shrink-0 items-center rounded-[4px] p-0.5 outline-none', 'text-fg-4 hover:bg-row-hover hover:text-fg-1')}
    >
      <MoreHorizontal className="size-4" />
    </button>
  )
}

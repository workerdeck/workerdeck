import type { SessionRow } from '@workerdeck/protocol'
import { SessionItem, cn } from '@workerdeck/ui'
import { MoreHorizontal } from 'lucide-react'

/**
 * One session in the sidebar list.
 *
 * **The card itself is `packages/ui`'s `SessionItem` now, and that is the whole
 * point of this file being ten lines of props.** The card was born here — the
 * dashboard had no sub-agent rows, no context ring and no vendor colour until
 * they were lifted out of this webview — and for a while the two lists were two
 * hand-kept copies of one design. They agreed on the model (protocol's
 * `SessionRow`, `sessionSteps`, `sessionState`) and disagreed on every
 * measurement: different gutters, different type sizes, different selection.
 * One component, two thin hosts, is the arrangement that keeps them one product.
 *
 * What is left here is genuinely extension-shaped, and it is exactly two things:
 *
 * - **The overflow is a native menu.** No webview in this extension draws its
 *   own chrome, and a popover anchored in a sidebar this narrow would be
 *   clipped by the view's own bounds anyway — so the glyph posts
 *   `wd-session-menu` and the host opens a QuickPick. The dashboard, which has
 *   room, spends the same slot on three hover actions instead.
 * - **Rename is a double-click on the title**, which is `SessionItem`'s default
 *   and the editor's own feel: a rename is a thing you do to the word you are
 *   looking at. A session is named on the gateway, so the new name travels to
 *   every other client; clearing it restores the derived title.
 *
 * The colours are not this file's business either. `styles.css` repoints the ui
 * tokens at `--vscode-*` — including `--row-hover` and `--row-selected` at
 * `list.hoverBackground` / `list.activeSelectionBackground` — so the card wears
 * the user's theme without a single VS Code variable being named in here.
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

/**
 * The card's overflow. Always visible, not hover-revealed: a hover action is
 * undiscoverable on a touchpad-shy scan, and one glyph that opens a native menu
 * costs the row less than three icons would.
 */
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

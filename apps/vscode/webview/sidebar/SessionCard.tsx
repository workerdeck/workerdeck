import type { SessionInfo } from '@workerdeck/protocol'
import { Spinner, formatRelativeTime, friendlyModel, cn } from '@workerdeck/ui'
import { BellRing, CircleAlert, CircleSlash, MoreHorizontal, Moon, PauseCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  ContextRing,
  EngineIcon,
  ProjectIcon,
  StepRow,
  StepToggle,
  runningSteps,
  sessionSteps,
  vendorMarkClass,
  vendorTextClass,
} from '@workerdeck/ui'
import { projectLabel, projectSubpath, sessionLabel } from '../../src/view-config.ts'

/**
 * One session in the sidebar list — an inset rounded **card**, two lines and an
 * optional list of work under them.
 *
 * **Line one is what it is doing and what it is called**: the state leads, as a
 * glyph in front of the title, and the unread count closes the line. The glyph
 * leads because a sessions list is scanned for *state* first — which of these is
 * working, which is waiting on me — and the title is what you read once the
 * glyph has told you which row to read. (This reverses an earlier rule, "the
 * title owns the left edge"; the earlier rule optimised for reading one row and
 * this one for scanning twenty.) The title also **dims when the session is not
 * live**: an idle row is context, and spending full contrast on twelve of them
 * is what made the one that is working hard to find.
 *
 * **Line two is what it is**: the engine's mark and its model in the engine's
 * own colour, then the **project** and the age, muted. The project replaced the
 * cwd's basename in that slot, and it is a replacement rather than an addition
 * because the folder was only ever a proxy for the question the project name
 * answers directly — *which of my repos is this*. `projectLabel` falls back to
 * exactly the basename the row drew before, so an undeclared project is
 * byte-identical to what shipped; a declared one says `WorkerDeck` where twelve
 * rows used to say `ui`, `server`, `web`.
 *
 * **The colour is a vendor cue, and it is carried by the mark and the model
 * together** — neither alone says whose engine this is at 13px. It survives
 * this webview's rule that a lone coral element reads as a stray token
 * (`styles.css`, the `--term-mark` repoint), because that rule is about the
 * *panel's* working marker, where coral competed with the editor's accent for a
 * meaning the editor owns; here it competes with nothing and names a vendor.
 * Two of them do now (`VENDOR_CLASS`): the rule is symmetric, so colouring one
 * vendor and not the other made the absence of colour mean something it does
 * not.
 *
 * **Selection is the card's own fill**, not a gutter bar: the card is already an
 * inset shape with air around it, so filling it is unambiguous in a way a fill
 * on a full-bleed row is not, and it leaves the left edge to the state glyph.
 * Hover is the same fill one step down.
 *
 * The name is editable in place by **double-clicking it** — there is no menu
 * entry, because a rename is a thing you do to the word you are looking at. A
 * session is named on the gateway, so the new name travels to every other
 * client; clearing it restores the derived title.
 */
/**
 * The card's icon column — one fixed width, shared by both lines.
 *
 * The two glyphs are deliberately different sizes (the state leads line one and
 * has to be findable at a glance; the vendor mark is a label on line two), and
 * laying them out as plain flex children meant each line's text started at
 * `icon + gap` — 20px against 18px. Two pixels is invisible as a measurement
 * and obvious as a misalignment: the title sat a notch right of the model
 * under it, and the glyphs' own ink disagreed by more, the smaller mark being
 * flush left in a narrower box.
 *
 * A fixed 14px cell with the glyph centred in it fixes both at once — the text
 * columns land on one edge because the cell is one width, and the ink centres
 * agree because centring is what the cell does. It is `packages/ui`'s terminal
 * gutter argument (a marker column is a column, not a leading character) at
 * card scale.
 */
function Gutter({ children }: { children: React.ReactNode }) {
  return <span className='flex w-3.5 shrink-0 items-center justify-center'>{children}</span>
}

export function SessionCard({
  info,
  hostName,
  showProject = true,
  projectIcons,
  unseen = 0,
  selected,
  onSelect,
  onSelectSubagent,
  onRename,
  onMenu,
}: {
  info: SessionInfo
  /** Shown when the list isn't already grouped by gateway. */
  hostName?: string
  /**
   * False when the list is already grouped by project — the header above this
   * row has said the name, so the row must not spend its metadata line
   * repeating it. What takes the slot is the *sub-path inside the project*
   * (`projectSubpath`): `packages/ui`, `packages/server`, the one thing the
   * header cannot say and the only thing telling two sessions in one repo
   * apart. A session at the project root has nothing to add and the slot
   * disappears. Exactly the rule `hostName` follows one facet over.
   */
  showProject?: boolean
  /** Resolved project-icon bytes by content hash — see `ProjectIconCache`.
   * A hash this map has not got yet simply draws no icon. */
  projectIcons?: Record<string, string>
  /** Turns since this session was last on screen. 0 draws no badge. */
  unseen?: number
  selected: boolean
  onSelect: () => void
  /** Open the session *at* one of its sub-agents — see `wd-select-session`'s
   * `revealToolUse`. */
  onSelectSubagent: (toolUseId: string) => void
  onRename: (title: string) => void
  /** Open the card's overflow menu. Native, host-side — see `onMenu` below. */
  onMenu: () => void
}) {
  const [editing, setEditing] = useState(false)
  // Expansion is the row's own state and deliberately not persisted: a list that
  // reopened yesterday's work on every window reload would be showing a settled
  // tail nobody asked for. It also cannot be a native twisty — every view in
  // this extension is a webview, so there is no tree to hang one on.
  const [expanded, setExpanded] = useState(false)
  const steps = sessionSteps(info, onSelectSubagent)
  const running = info.status === 'running' || info.status === 'starting'
  const needsHuman = info.pendingPermissionCount > 0 || info.status === 'awaiting_approval'
  const live = running || needsHuman
  const age = info.lastActivityAt ?? info.createdAt
  // protocol's own spelling, so the row, the group header this row sits under
  // and the project facet cannot disagree about what a project is called.
  const project = showProject ? projectLabel({ info }) : projectSubpath({ info })
  const projectIcon = showProject ? info.project?.icon : undefined
  const engine = info.engine ?? 'claude'
  // The model id as a person says it — `claude-opus-5[1m]` is a wire value, and
  // a sidebar line has no room to spend on a context-window suffix.
  const model = friendlyModel(info.model)
  // The vendor's own colour (`--vendor-*`, now `packages/ui`'s tokens). How far
  // it reaches past the mark is per vendor — see `vendorTextClass`.
  const vendorMark = vendorMarkClass(engine, info.model)
  const vendor = vendorTextClass(engine, info.model)
  // Only the `image` arm needs bytes, and only once the host has fetched them;
  // until then (and for a glyph) this is undefined and draws nothing.
  const iconSrc =
    projectIcon?.type === 'image' ? projectIcons?.[projectIcon.hash] : undefined

  return (
    <div
      role='button'
      tabIndex={0}
      /* Only the FIRST click of a click-streak selects. Selecting reveals the
         agent panel and focuses its composer (`panel.show({ focus: true })`),
         so the second click of a double-click would steal focus a beat after
         the rename editor mounted — the editor appearing and vanishing in the
         same gesture. `detail` counts the streak; anything past the first is
         the double-click the title is listening for. */
      onClick={(e) => {
        if (e.detail > 1) return
        onSelect()
      }}
      onKeyDown={(e) => {
        // Only when the card ITSELF has focus. A press on something inside it —
        // the disclosure, a step, the menu — already fires that control's own
        // click, and `stopPropagation` there cannot help: the keydown is a
        // separate event travelling the same path, so an unguarded handler ran
        // the control's action AND selected the session.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      className={cn(
        'group flex w-full cursor-pointer flex-col overflow-hidden rounded-[5px] text-left',
        selected
          ? 'bg-(--vscode-list-activeSelectionBackground,var(--surface-hover)) text-(--vscode-list-activeSelectionForeground,inherit)'
          : 'hover:bg-(--vscode-list-hoverBackground,var(--surface-hover))',
      )}>
      <div className='flex flex-col gap-1 px-2.5 py-1.5'>
        <div className='flex items-center gap-1.5 overflow-hidden'>
          <Gutter>
            <StatusIcon needsHuman={needsHuman} running={running} status={info.status} />
          </Gutter>
          {editing ? (
            <NameEditor
              initial={info.title ?? ''}
              onCommit={(title) => {
                setEditing(false)
                if (title !== (info.title ?? '')) onRename(title)
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
              className={cn(
                'min-w-0 flex-1 truncate text-body-sm font-medium',
                live || selected ? 'text-fg-1' : 'text-fg-3',
              )}>
              {sessionLabel(info)}
            </span>
          )}
          {/* What arrived while you were elsewhere. Turns, because that is what
              the sessions poll can count without attaching. */}
          {unseen > 0 ? (
            <span
              title={`${unseen} new turn${unseen === 1 ? '' : 's'} since you last looked`}
              className='shrink-0 rounded-full bg-(--vscode-activityBarBadge-background,var(--accent)) px-2 py-0.5 text-label leading-none text-(--vscode-activityBarBadge-foreground,var(--accent-fg))'>
              {unseen}
            </span>
          ) : null}
          {/* How long since it moved. It used to ride the end of line two, and
              it moved up because line two is now a run of *identity* — engine,
              model, project, gateway — and an age at the end of that run is the
              one part of it that keeps changing while you read. Up here it sits
              beside the reading it belongs with. */}
          <span className='shrink-0 text-fg-4'>{formatRelativeTime(age)}</span>
          {/* How full the window is, at a glance and across the whole list —
              the question you cannot ask from inside one session. The same
              component the dashboard's row draws, so the thresholds cannot
              diverge; absent draws nothing (see `SessionInfo.contextUsage`). */}
          <ContextRing usage={info.contextUsage} />
        </div>
        <div className='flex items-center gap-1.5 overflow-hidden text-label'>
          {/* The class goes ON the icon, not on the gutter. `EngineIcon` draws
              `fill="currentColor"` and carries its own `text-fg-3`, so a colour
              inherited from a parent loses to the svg's own class — which is
              exactly how the mark stayed muted while the model went coral.
              `cn` is tailwind-merge, so passing it in replaces the default. */}
          <Gutter>
            <EngineIcon engine={engine} model={info.model} className={vendorMark} />
          </Gutter>
          {/* One truncating span, not a flex of pieces: the parts have a
              priority order (model, then project, then gateway) and a single
              ellipsis honours it for free, where flex children would each shrink
              a little and leave three half-words. The icon rides inside it as an
              inline element for the same reason — it clips with the text it
              labels instead of holding a slot the text has lost. */}
          <span className='min-w-0 flex-1 truncate text-fg-4'>
            <span className={vendor}>{model}</span>
            {/* Conditional as a whole — separator, icon and name together. A
                session at its project's root has no sub-path to show under a
                project group, and an empty slot would leave ` ·  · ` behind. */}
            {project === undefined ? null : (
              <>
                {' · '}
                <ProjectIcon
                  icon={projectIcon}
                  src={iconSrc}
                  name={project}
                  /* Nudged onto the text baseline: the glyph box is 12px against
                     an 11px line, so it sits a hair proud without this. */
                  className='mr-1 align-[-0.2em]'
                />
                {project}
              </>
            )}
            {hostName ? ` · ${hostName}` : ''}
          </span>
          {/* The disclosure lives here, not in front of the title: line one's
              left edge belongs to the state glyph and the name. It doubles as
              the count, so the row says how much there is without being
              opened. */}
          {steps.length > 0 ? (
            <StepToggle
              expanded={expanded}
              running={runningSteps(steps)}
              total={steps.length}
              noun={steps[0]!.noun}
              onToggle={() => setExpanded((open) => !open)}
            />
          ) : null}
          {/* Always visible, not hover-revealed. A hover action is undiscoverable
              on a touchpad-shy scan and there are three of them now; one glyph
              that opens a native menu costs the row less than three icons. */}
          <CardMenu onOpen={onMenu} />
        </div>
      </div>
      {expanded
        ? steps.map((step) => <StepRow key={step.key} step={step} onSelect={step.onSelect} />)
        : null}
    </div>
  )
}

/**
 * The card's overflow. The menu itself is a native QuickPick, opened host-side:
 * no webview in this extension draws its own chrome, and a popover anchored in a
 * sidebar this narrow would be clipped by the view's own bounds anyway.
 */
function CardMenu({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type='button'
      aria-label='Session actions'
      title='Session actions'
      onClick={(e) => {
        // The whole card is a button; this one does not mean "select".
        e.stopPropagation()
        onOpen()
      }}
      className='shrink-0 rounded p-0.5 text-fg-4 outline-none hover:bg-surface-hover hover:text-fg-1'>
      <MoreHorizontal className='size-3.5' />
    </button>
  )
}

/**
 * Enter commits, Escape cancels, blur commits — the VS Code inline-rename feel.
 * An empty value is a deliberate "clear the name", which the gateway answers by
 * handing back the derived title.
 *
 * The blur rule needs one guard. Selecting a session focuses the agent panel —
 * a different VS Code view — so this webview's document can lose focus a tick
 * after a double-click opened the editor, and an unguarded blur reads that as
 * "the user clicked away" and closes the editor in the frame it appeared.
 * `document.hasFocus()` tells the two apart: focus moving WITHIN this webview is
 * the user leaving the field; the whole webview losing focus is not. When the
 * window comes back, so does the caret.
 */
function NameEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (title: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  useEffect(() => {
    const onWindowFocus = () => {
      ref.current?.focus()
      ref.current?.select()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      spellCheck={false}
      placeholder='Session name'
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (document.hasFocus()) onCommit(value.trim())
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(value.trim())
        else if (e.key === 'Escape') onCancel()
      }}
      /* The negative margin is load-bearing: the border (1px) and padding (1px)
         make the input 4px taller than the label it replaces, and the card would
         grow by that much the moment a rename starts. -2px per side cancels it
         exactly, so the row keeps its height and the list never shifts. */
      className='-my-0.5 min-w-0 flex-1 rounded-sm border border-(--vscode-focusBorder,var(--accent)) bg-bg px-1 py-px text-body-sm leading-5 text-fg-1 outline-none'
    />
  )
}

function StatusIcon({
  needsHuman,
  running,
  status,
}: {
  needsHuman: boolean
  running: boolean
  status: SessionInfo['status']
}) {
  if (needsHuman) return <BellRing className='size-3.5 shrink-0 animate-pulse text-warning' />
  if (running) return <Spinner className='size-3.5 shrink-0 text-info' />
  switch (status) {
    case 'failed':
      return <CircleAlert className='size-3.5 shrink-0 text-danger' />
    case 'closed':
      return <CircleSlash className='size-3.5 shrink-0 text-fg-4' />
    case 'parked':
      return <PauseCircle className='size-3.5 shrink-0 text-fg-3' />
    default:
      return <Moon className='size-3.5 shrink-0 text-fg-4' />
  }
}

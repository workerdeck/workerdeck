import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { projectLabel, projectSubpath, sessionLabel } from '@workerdeck/protocol'
import type { SessionRow } from '@workerdeck/protocol'
import { ContextRing } from './ContextRing.tsx'
import { EngineIcon, vendorMarkClass, vendorTextClass } from './EngineIcon.tsx'
import { ProjectIcon } from './ProjectIcon.tsx'
import { SessionStatusIcon } from './SessionStatusIcon.tsx'
import { StepRow, StepToggle, runningSteps, sessionSteps } from './SessionSteps.tsx'
import type { Step } from './SessionSteps.tsx'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatRelativeTime, friendlyModel } from '../../lib/format.ts'

/**
 * One session in a list — the **card**, and the only drawing of it in the product (the dashboard's
 * `SessionBrowser`, the VS Code sidebar; iOS mirrors this file's geometry). Two 20px lines over a
 * shared 16px gutter cell, and **the blue always marks the finest thing selected**: opening a
 * sub-agent selects its session too, so the agent takes `--row-selected` and the card steps back
 * to `--row-selected-weak`. Geometry and the rest of the rules: docs/PACKAGES.md §`packages/ui`.
 */
export interface SessionItemProps {
  row: SessionRow
  /** This session is the one the host is showing. */
  active?: boolean
  /**
   * Which sub-agent is open, by `Step.key` — the *finer* of the two selections.
   * When it names one of this card's agents, that step takes the blue and the
   * card drops to the secondary grey. A key belonging to some other card's
   * agent, or to a task, changes nothing here.
   */
  activeStepKey?: string
  /** Shown when the list is not already grouped by gateway. */
  showGateway?: boolean
  /**
   * False when the list is already grouped by project: the header has said the
   * name, so the slot goes to the *sub-path inside the project*
   * (`projectSubpath`) instead — the only thing that tells two sessions in one
   * repo apart. A session at the project root drops the slot entirely.
   */
  showProject?: boolean
  /** Resolved project-icon bytes by content hash. A hash this map has not got
   * yet simply draws no icon. */
  projectIcons?: Record<string, string>
  /** Uncontrolled by default — pass both to drive expansion from the host. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  onSelect?: () => void
  /** Open the session *at* one of its sub-agents — hand the panel body over to
   * that agent's own work. Only ever called for an **agent** step. Absent is not
   * a missing feature: without it a step just opens the session, which is all a
   * host with no sub-agent surface can offer. */
  onSelectSubagent?: (toolUseId: string) => void
  /**
   * Open the session and travel to a **task**'s row in the transcript. A
   * separate seam from `onSelectSubagent` because a task has no agent behind
   * it: framing its tool-use id selects no items and draws an empty agent view.
   */
  onRevealStep?: (toolUseId: string) => void
  /** Enables in-place rename. The trigger is the host's — see `renameOn`. */
  onRename?: (title: string) => void
  /** How a rename starts. `external` means the host opens it from its own
   * affordance and drives it through `editing`/`onEditingChange`. */
  renameOn?: 'doubleClick' | 'external'
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  /** The card's trailing controls, at the end of line two. A single overflow
   * glyph is what the design draws; a host with three always-on actions can put
   * them here instead. */
  actions?: ReactNode
  className?: string
}

export function SessionItem({
  row,
  active = false,
  activeStepKey,
  showGateway,
  showProject = true,
  projectIcons,
  expanded,
  onExpandedChange,
  onSelect,
  onSelectSubagent,
  onRevealStep,
  onRename,
  renameOn = 'doubleClick',
  editing,
  onEditingChange,
  actions,
  className,
}: SessionItemProps) {
  const { info } = row
  // Expansion is the card's own state unless the host takes it, and is
  // deliberately not persisted.
  const [ownExpanded, setOwnExpanded] = useState(false)
  const open = expanded ?? ownExpanded
  const setOpen = (next: boolean) => {
    setOwnExpanded(next)
    onExpandedChange?.(next)
  }
  const [ownEditing, setOwnEditing] = useState(false)
  const isEditing = editing ?? ownEditing
  const setEditing = (next: boolean) => {
    setOwnEditing(next)
    onEditingChange?.(next)
  }

  const engine = info.engine ?? 'claude'
  // protocol's own spelling, so this card, the group header above it and the
  // project facet cannot disagree about what a project is called.
  const project = showProject ? projectLabel(row) : projectSubpath(row)
  const projectIcon = showProject ? info.project?.icon : undefined
  const iconSrc = projectIcon?.type === 'image' ? projectIcons?.[projectIcon.hash] : undefined
  // A session that has spent nothing contributes **nothing** rather than
  // `formatCost`'s em-dash: `· — ·` is punctuation pretending to be a reading.
  const cost = formatCost(info.totalCostUsd)
  const extras = [
    showGateway ? row.hostName : undefined,
    info.profile ? `@${info.profile}` : undefined,
    cost === '—' ? undefined : cost,
  ].filter((part): part is string => Boolean(part))

  // A **list of present parts**, never a template with conditionals: every part
  // here is genuinely optional, and a list means the separator is drawn
  // *between* parts and there is one rule to get right.
  const model = friendlyModel(info.model)
  const parts: ReactNode[] = []
  if (model) {
    parts.push(
      // The model id as a person says it: `claude-opus-5[1m]` is a wire value.
      <span key="model" className={vendorTextClass(engine, info.model)}>
        {model}
      </span>,
    )
  }
  if (project !== undefined) {
    parts.push(
      <span key="project">
        <ProjectIcon
          icon={projectIcon}
          src={iconSrc}
          name={project}
          /* 16px, the same box as the engine mark in the gutter, and nudged onto
             the text baseline: the box is taller than the line, so it sits a
             hair proud without this. */
          className="mr-1.5 size-4 align-[-0.3em]"
        />
        {project}
      </span>,
    )
  }
  for (const extra of extras) {
    parts.push(<span key={extra}>{extra}</span>)
  }
  // Where a step press goes, by kind: an **agent** gets the frame, a **task**
  // gets travelled to. Both fall back to plainly opening the session.
  const steps = sessionSteps(info, (toolUseId, kind) => {
    if (kind === 'agent') {
      return onSelectSubagent ? onSelectSubagent(toolUseId) : onSelect?.()
    }
    return onRevealStep ? onRevealStep(toolUseId) : onSelect?.()
  })
  // Matched against the card's own steps, never on `activeStepKey` alone: every
  // card is handed the same key, so a bare truthiness check would turn all of
  // them grey the moment any one agent opened.
  const holdsOpenAgent = steps.some((s) => s.kind === 'agent' && s.key === activeStepKey)

  return (
    <div
      data-slot="session-item"
      data-active={active || undefined}
      role="button"
      tabIndex={0}
      /* Only the FIRST click of a streak selects: selecting focuses the
         composer, so a double-click would steal focus a beat after the rename
         editor mounted. */
      onClick={(e) => {
        if (e.detail > 1 || isEditing) {
          return
        }
        onSelect?.()
      }}
      onKeyDown={(e) => {
        // Only when the card ITSELF has focus: a keydown on an inner control is
        // a separate event on the same path, so an unguarded handler would run
        // the control's action AND select the session.
        if (e.target !== e.currentTarget) {
          return
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect?.()
        }
      }}
      className={cn(
        'group flex w-full cursor-pointer flex-col p-1 text-left outline-none',
        'rounded-[4px] transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        // Priority order: an open sub-agent OUTRANKS a selected session, since
        // both are true at once and the blue marks the finer claim. A filled
        // card does not also answer hover.
        holdsOpenAgent ? 'bg-row-selected-weak' : active ? 'bg-row-selected' : 'hover:bg-row-hover',
        className,
      )}
    >
      <div className="flex flex-col gap-1 py-0.5 pr-0.5 pl-1.5">
        {/* Line one — state, name, and the two readings that keep moving. 6px
            between cells against 4px between the lines: a horizontal gap
            separates a glyph from the words it labels, a vertical one separates
            lines that already have their own leading. */}
        <div className="flex h-5 items-center gap-1.5 overflow-hidden">
          <Gutter>
            <SessionStatusIcon row={row} />
          </Gutter>
          {isEditing && onRename ? (
            /* The editor replaces the title: an input nested in a button is
               invalid markup, and disabling the button disables the field. */
            <NameEditor
              initial={info.title ?? ''}
              onCommit={(title) => {
                setEditing(false)
                if (title !== (info.title ?? '')) {
                  onRename(title)
                }
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <span
              onDoubleClick={
                onRename && renameOn === 'doubleClick'
                  ? (e) => {
                      e.stopPropagation()
                      setEditing(true)
                    }
                  : undefined
              }
              className="min-w-0 flex-1 truncate text-body-sm font-medium tracking-[-0.005em] text-fg-1"
            >
              {sessionLabel(info)}
            </span>
          )}
          {row.unseen > 0 ? (
            /* Transcript rows since this session was last on screen — the same
               unit the VS Code activity-bar badge counts.

               **The colour is the state's, not the count's**: on a live session
               unread is a call to look, on a settled one the same number is a
               record. */
            <span
              title={`${row.unseen} new`}
              className={cn(
                'flex h-4 min-w-6 shrink-0 items-center justify-center rounded-full px-2',
                'text-[0.75rem] leading-none tracking-[-0.005em] tabular-nums',
                row.state === 'working' || row.state === 'attention' ? 'bg-accent text-accent-fg' : 'bg-badge text-badge-fg',
              )}
            >
              {row.unseen}
            </span>
          ) : null}
          {/* Absent draws nothing, and absent is not zero. */}
          <ContextRing usage={info.contextUsage} size={16} className="p-0.5" />
        </div>

        {/* Line two — what it is, where it runs, what it cost, how old it is. */}
        <div className="flex h-5 items-center gap-1.5 overflow-hidden text-body-sm tracking-[-0.005em]">
          <Gutter>
            {/* The colour goes ON the icon, not on a parent: the svg ships its
                own `text-fg-3` and only a class on the element merges over it. */}
            <EngineIcon engine={engine} model={info.model} className={cn('size-4', vendorMarkClass(engine, info.model))} />
          </Gutter>
          {/* **One truncating run and one atom**, not five cells. The run is
              one span because its parts have a priority order and a single
              ellipsis honours it for free; five flex children get either a
              mid-glyph clip or four half-words with no ellipsis anywhere.
              **The age is not in the run** — it is its own shrink-0 cell,
              because inside it was the first thing an ellipsis ate. */}
          <span className="min-w-0 truncate text-fg-4">
            {/* Separators live BETWEEN parts and are never attached to one: an
                absent part would otherwise leave its separator behind. */}
            {parts.map((part, i) => (
              <Fragment key={i}>
                {i > 0 ? ' · ' : ''}
                {part}
              </Fragment>
            ))}
          </span>
          <span className="shrink-0 text-fg-4">
            {parts.length > 0 ? '· ' : ''}
            {formatRelativeTime(info.lastActivityAt ?? info.createdAt)}
          </span>
          {/* The slack goes HERE, after the age, never into the identity run:
              the run and the age are one reading, and what floats is the gap
              before the controls. Basis 0, so it only ever takes *surplus* —
              under a deficit the run truncates instead. */}
          <span className="min-w-0 flex-1" />
          {steps.length > 0 ? (
            <StepToggle
              expanded={open}
              running={runningSteps(steps)}
              total={steps.length}
              noun={steps[0]!.noun}
              onToggle={() => setOpen(!open)}
            />
          ) : null}
          {actions}
        </div>
      </div>

      {open && steps.length > 0 ? (
        <div className="flex flex-col">
          {steps.map((step: Step) => (
            <StepRow key={step.key} step={step} active={step.key === activeStepKey} onSelect={step.onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The one 16px cell both lines hang their glyph in — the two marks are
 * different widths, and centring in a fixed cell is what makes the two text
 * columns start at the same x. */
const Gutter = ({ children }: { children: ReactNode }) => (
  <span className="flex size-4 shrink-0 items-center justify-center">{children}</span>
)

/**
 * Enter commits, Escape cancels, blur commits. An empty value is a deliberate
 * "clear the name", which the gateway answers with the derived title.
 *
 * The blur needs `document.hasFocus()`: selecting a session focuses a different
 * surface (in the extension, a different VS Code view), so an unguarded blur
 * closes the editor in the frame it appeared. Focus moving *within* this
 * document is the user leaving the field; the whole view losing focus is not.
 */
const NameEditor = ({ initial, onCommit, onCancel }: { initial: string; onCommit: (title: string) => void; onCancel: () => void }) => {
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
      placeholder="Session name"
      aria-label="Session name"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (document.hasFocus()) {
          onCommit(value.trim())
        }
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          onCommit(value.trim())
        } else if (e.key === 'Escape') {
          onCancel()
        }
      }}
      /* The negative margin is load-bearing: border + padding make the input
         taller than the label it replaces, and the card would grow the moment a
         rename starts. */
      className={cn(
        '-my-0.5 min-w-0 flex-1 rounded-sm border border-ring bg-bg px-1 py-px',
        'text-body-sm leading-5 text-fg-1 outline-none',
      )}
    />
  )
}

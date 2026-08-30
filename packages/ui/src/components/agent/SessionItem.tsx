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
 * One session in a list — the **card**, and the only drawing of it in the
 * product.
 *
 * The dashboard's `SessionBrowser` and the VS Code sidebar both render this;
 * before it existed they rendered two hand-kept copies that agreed on the model
 * and disagreed on every measurement, and the two lists read as two products.
 * iOS mirrors this file's geometry rather than either copy.
 *
 * ## The shape
 *
 * A 4px-padded, 4px-rounded card whose whole surface is the hit target, holding
 * two 20px lines and, when it is open, the work under them.
 *
 * **Line one is state and identity**: the status glyph leads, the title takes
 * the rest, and the line closes with the unread badge and the context ring. The
 * glyph leads because a sessions list is scanned for *state* first — which of
 * these is working, which is waiting on me — and the title is what you read once
 * the glyph has told you which row to read. The two readings that close the line
 * are the two that change while you are looking at them.
 *
 * **Line two is identity and cost**: the engine's mark and its model in the
 * vendor's own colour, then the project, then everything else the host wants
 * said, then the age — a `·`-joined run that ends in the one part of it that
 * keeps moving. The line's right edge belongs to the disclosure (which doubles
 * as the count of the work below, so the card says how much there is without
 * being opened) and to the host's own actions.
 *
 * **The gutter is one 16px cell, shared by both lines.** The two glyphs are
 * different sizes and laying them out as plain flex children starts the two
 * text columns at different x — two pixels, invisible as a measurement and
 * obvious as a misalignment. Centring inside a fixed cell fixes the text edges
 * and the ink centres at once. It is the terminal gutter's argument at card
 * scale.
 *
 * ## Selection
 *
 * **Selection is the card's own fill**, not a gutter bar: the card is an inset
 * shape with air around it, so filling it is unambiguous in a way a fill on a
 * full-bleed row is not, and it leaves the left edge to the state glyph.
 *
 * There are **two selections at two grains**, and the card and its steps split
 * them:
 *
 * | what is on screen | card | the step |
 * | --- | --- | --- |
 * | nothing | transparent, hovers | transparent, hovers |
 * | this session | `--row-selected` (blue) | transparent, hovers |
 * | one of its sub-agents | `--row-selected-weak` (grey) | `--row-selected` (blue) |
 *
 * **The blue always marks the finest thing selected.** Opening a sub-agent
 * selects its session too, so both claims are true at once and the blue can only
 * carry one; it goes to the agent, and the card steps back to grey — present,
 * holding what you are looking at, not itself the thing you are looking at.
 * Reversing that (blue card, blue row inside it) says nothing, which is what a
 * blue-on-blue card looked like.
 *
 * A filled card does **not** also answer hover: the fill is already spent, and a
 * selected row that lightened under the pointer read as a third state nobody
 * could name. Its steps still do, on `--row-active`, which is a tint and so
 * works on all three grounds.
 *
 * A **task** never takes the blue. It is a reference to a place inside a
 * session, so pressing one selects the session and travels to its marker — see
 * `StepRow`.
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
   * False when the list is already grouped by project — the header above has
   * said the name, so the card must not spend its metadata line repeating it.
   * What takes the slot is the *sub-path inside the project*
   * (`projectSubpath`): `packages/ui`, `packages/server` — the one thing the
   * header cannot say and the only thing that tells two sessions in one repo
   * apart. A session at the project root has nothing to add and the slot
   * disappears entirely. Exactly the rule `showGateway` follows one facet over.
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
   * Open the session and travel to a **task**'s row in the transcript — where
   * the work was started, and where it finished.
   *
   * A separate seam from `onSelectSubagent` because the destinations are
   * different, and conflating them is not a styling detail: a task has no agent
   * behind it, so framing its tool-use id selects **no items at all** and the
   * panel draws an empty agent view. That was the bug. A task is a reference,
   * and the only honest thing to do with a reference is follow it.
   */
  onRevealStep?: (toolUseId: string) => void
  /** Enables in-place rename. The trigger is the host's — see `renameOn`. */
  onRename?: (title: string) => void
  /**
   * How a rename starts. `doubleClick` is the editor feel (a rename is a thing
   * you do to the word you are looking at); `external` means the host opens it
   * from its own affordance — a menu entry, a pencil in `actions` — and drives
   * it through `editing`/`onEditingChange`.
   */
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
  // deliberately not persisted: a list that reopened yesterday's work on every
  // reload would be showing a settled tail nobody asked for.
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
  // Everything between the project and the age. Plain strings, because none of
  // them wears a colour or an icon — the two that do are drawn as their own
  // cells either side of this run.
  //
  // A session that has spent nothing contributes **nothing**, rather than
  // `formatCost`'s em-dash. A dash is the right answer in a details panel, where
  // the row exists to be read and an empty cell would look broken; here it is a
  // segment of a `·`-joined run competing for the width the project name needs,
  // and `· — ·` is punctuation pretending to be a reading.
  const cost = formatCost(info.totalCostUsd)
  const extras = [
    showGateway ? row.hostName : undefined,
    info.profile ? `@${info.profile}` : undefined,
    cost === '—' ? undefined : cost,
  ].filter((part): part is string => Boolean(part))

  // The metadata run, assembled as a **list of present parts** rather than as a
  // template with conditionals in it. Every one of these is genuinely optional —
  // a session reports no model until its first turn, a session outside any
  // declared project has no name to show, a session at its project's root has no
  // sub-path — and a template makes each absence a separate place to remember
  // the separator. Built as a list, the separator is drawn *between* parts and
  // there is exactly one rule to get right.
  //
  // This is not hypothetical tidiness: `friendlyModel(undefined)` is `undefined`,
  // so a session with no model yet drew an empty span followed by the project's
  // leading `· `, and the line opened with a separator attached to nothing.
  const model = friendlyModel(info.model)
  const parts: ReactNode[] = []
  if (model) {
    parts.push(
      // The model id as a person says it — `claude-opus-5[1m]` is a wire value,
      // and a card line has no room for a context-window suffix.
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
  // Where a step press goes, by kind. An **agent** has work of its own and gets
  // the frame; a **task** is a marker and gets travelled to. Both fall back to
  // plainly opening the session, which is the whole of what a host that can do
  // neither has to offer — and is still better than a destination that renders
  // empty.
  const steps = sessionSteps(info, (toolUseId, kind) => {
    if (kind === 'agent') {
      return onSelectSubagent ? onSelectSubagent(toolUseId) : onSelect?.()
    }
    return onRevealStep ? onRevealStep(toolUseId) : onSelect?.()
  })
  // Whether the thing on screen is one of THIS card's sub-agents. Matched
  // against the card's own steps rather than taken on trust from `activeStepKey`
  // alone: every card in the list is handed the same key, and a bare truthiness
  // check would turn all of them grey the moment any one agent opened. Tasks are
  // excluded because a task is a place to go, not a thing to hold — see
  // `StepRow`.
  const holdsOpenAgent = steps.some((s) => s.kind === 'agent' && s.key === activeStepKey)

  return (
    <div
      data-slot="session-item"
      data-active={active || undefined}
      role="button"
      tabIndex={0}
      /* Only the FIRST click of a click-streak selects. Selecting reveals the
         session and focuses its composer, so the second click of a double-click
         would steal focus a beat after the rename editor mounted — the editor
         appearing and vanishing in the same gesture. `detail` counts the
         streak; anything past the first is the double-click the title is
         listening for. */
      onClick={(e) => {
        if (e.detail > 1 || isEditing) {
          return
        }
        onSelect?.()
      }}
      onKeyDown={(e) => {
        // Only when the card ITSELF has focus. A press on something inside it —
        // the disclosure, a step, the overflow — already fires that control's
        // own click, and `stopPropagation` there cannot help: the keydown is a
        // separate event travelling the same path, so an unguarded handler ran
        // the control's action AND selected the session.
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
        // Three states, one place, in priority order. A sub-agent being open
        // OUTRANKS the session being selected, because both are true at once —
        // opening an agent selects its session too — and the blue can only mean
        // one of them. It goes to the finer claim; the card keeps the coarser
        // one in grey. A filled card does not also answer hover: the fill is
        // already spent, and a selected row that lightened under the pointer
        // read as a third state nobody could name.
        holdsOpenAgent ? 'bg-row-selected-weak' : active ? 'bg-row-selected' : 'hover:bg-row-hover',
        className,
      )}
    >
      <div className="flex flex-col gap-1 py-0.5 pr-0.5 pl-1.5">
        {/* Line one — state, name, and the two readings that keep moving.

            **6px between cells, where the column between the lines is 4px.**
            Not a rounding wobble: a horizontal gap separates a glyph from the
            words it labels, and 4px put the two close enough to read as one
            smudge at 13px; a vertical gap separates two lines that are already
            separated by their own leading, so it needs less. The design was
            redrawn to this once the vendor marks lost the transparent padding
            that had been standing in for the missing space. */}
        <div className="flex h-5 items-center gap-1.5 overflow-hidden">
          <Gutter>
            <SessionStatusIcon row={row} />
          </Gutter>
          {isEditing && onRename ? (
            /* The editor replaces the title rather than sitting inside it — an
               input nested in a button is invalid markup, and disabling the
               button to protect the edit disables the field with it. */
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
               unit the VS Code activity-bar badge counts, because turns
               undercount badly.

               **The colour is the state's, not the count's.** On a live session
               unread is a call to look, and it wears the accent. On a settled
               one the same number is a *record* — the turn is over, nothing is
               going to arrive, and there is nothing to answer — so it drops to
               the neutral badge. A list where every finished session still
               shouted in blue is a list where the blue stopped meaning
               anything, which is the whole reason the design draws two. */
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
          {/* How full the window is, at a glance and across the whole list — the
              question you cannot ask from inside one session. Absent draws
              nothing, and absent is not zero. */}
          <ContextRing usage={info.contextUsage} size={16} className="p-0.5" />
        </div>

        {/* Line two — what it is, where it runs, what it cost, how old it is. */}
        <div className="flex h-5 items-center gap-1.5 overflow-hidden text-body-sm tracking-[-0.005em]">
          <Gutter>
            {/* The colour goes ON the icon, not on a parent: the svg ships its
                own `text-fg-3` and only a class on the element itself merges
                over it. `cn` is tailwind-merge, so passing one replaces the
                default rather than losing to it. */}
            <EngineIcon engine={engine} model={info.model} className={cn('size-4', vendorMarkClass(engine, info.model))} />
          </Gutter>
          {/* **One truncating run and one atom, not five cells and not one
              span**, and both halves of that are load-bearing.

              The run is one span because its parts have a priority order —
              model, then project, then where it ran and what it cost — and a
              single ellipsis honours it for free. As five flex children they
              cannot: `shrink-0` everywhere clips mid-glyph (`$12.4` cut in
              half, a project name gone entirely behind its own icon), and
              letting them shrink costs each of them a little and leaves four
              half-words with no ellipsis anywhere. The project glyph rides
              inside as an inline element for the same reason — it clips with
              the text it labels instead of holding a slot that text has already
              lost.

              **The age is not in the run.** It sat at the end of it and was
              therefore the first thing an ellipsis ate, which is precisely
              backwards: `4m ago` is three characters that answer "is this
              still moving", and a truncated `4m …` answers nothing while a
              truncated project name still says which repo. So it is its own
              shrink-0 cell and the run yields to it. That is one ellipsis in
              one place, which is the whole reason not to use five cells. */}
          <span className="min-w-0 truncate text-fg-4">
            {/* Separators live BETWEEN parts and are never attached to one.
                Attached, a part that turned out to be absent left its own
                separator behind — which is what a session with no model
                recorded yet did: `friendlyModel(undefined)` is `undefined`, the
                model drew nothing, and the line opened with a `· ` in front of
                the project, hanging off nothing. */}
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
          {/* The slack goes HERE, after the age — not into the identity run.
              Giving the run `flex-1` made it absorb the surplus, which pushed
              the age to the far right on a card with no disclosure and left a
              hole between a project name and its own timestamp. The design
              draws the same spacer in the same place for the same reason: the
              run and the age are one reading, and what floats is the gap before
              the controls. Basis 0, so it only ever takes *surplus* — under a
              deficit it is worth nothing and the run truncates instead. */}
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

/**
 * The one 16px cell both lines hang their glyph in.
 *
 * A shared column rather than a leading character: the state and the engine mark
 * are different widths and a bare glyph would let the two text columns start at
 * different x. Centring inside a fixed cell is what makes them agree.
 */
function Gutter({ children }: { children: ReactNode }) {
  return <span className="flex size-4 shrink-0 items-center justify-center">{children}</span>
}

/**
 * Enter commits, Escape cancels, blur commits — the editor's inline-rename feel.
 * An empty value is a deliberate "clear the name", which the gateway answers by
 * handing back the derived title.
 *
 * The blur rule needs one guard. Selecting a session focuses a different surface
 * — in the extension, a different VS Code view — so this document can lose focus
 * a tick after a double-click opened the editor, and an unguarded blur reads
 * that as "the user clicked away" and closes the editor in the frame it
 * appeared. `document.hasFocus()` tells the two apart: focus moving WITHIN this
 * document is the user leaving the field; the whole view losing focus is not.
 * When the window comes back, so does the caret.
 */
function NameEditor({ initial, onCommit, onCancel }: { initial: string; onCommit: (title: string) => void; onCancel: () => void }) {
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
      /* The negative margin is load-bearing: the border (1px) and padding (1px)
         make the input taller than the label it replaces, and the card would
         grow by that much the moment a rename starts. Cancelling it exactly is
         what keeps the list from shifting under the caret. */
      className={cn(
        '-my-0.5 min-w-0 flex-1 rounded-sm border border-ring bg-bg px-1 py-px',
        'text-body-sm leading-5 text-fg-1 outline-none',
      )}
    />
  )
}

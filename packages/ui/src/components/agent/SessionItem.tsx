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

export interface SessionItemProps {
  row: SessionRow
  active?: boolean
  activeStepKey?: string
  showGateway?: boolean
  showProject?: boolean
  projectIcons?: Record<string, string>
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  onSelect?: () => void
  onSelectSubagent?: (toolUseId: string) => void
  onRevealStep?: (toolUseId: string) => void
  onRename?: (title: string) => void
  renameOn?: 'doubleClick' | 'external'
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
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
  const project = showProject ? projectLabel(row) : projectSubpath(row)
  const projectIcon = showProject ? info.project?.icon : undefined
  const iconSrc = projectIcon?.type === 'image' ? projectIcons?.[projectIcon.hash] : undefined
  const cost = formatCost(info.totalCostUsd)
  const extras = [
    showGateway ? row.hostName : undefined,
    info.profile ? `@${info.profile}` : undefined,
    cost === '—' ? undefined : cost,
  ].filter((part): part is string => Boolean(part))

  const model = friendlyModel(info.model)
  const parts: ReactNode[] = []
  if (model) {
    parts.push(
      <span key="model" className={vendorTextClass(engine, info.model)}>
        {model}
      </span>,
    )
  }
  if (project !== undefined) {
    parts.push(
      <span key="project">
        <ProjectIcon icon={projectIcon} src={iconSrc} name={project} className="mr-1.5 size-4 align-[-0.3em]" />
        {project}
      </span>,
    )
  }
  for (const extra of extras) {
    parts.push(<span key={extra}>{extra}</span>)
  }
  const steps = sessionSteps(info, (toolUseId, kind) => {
    if (kind === 'agent') {
      return onSelectSubagent ? onSelectSubagent(toolUseId) : onSelect?.()
    }
    return onRevealStep ? onRevealStep(toolUseId) : onSelect?.()
  })
  const holdsOpenAgent = steps.some((s) => s.kind === 'agent' && s.key === activeStepKey)

  return (
    <div
      data-slot="session-item"
      data-active={active || undefined}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (e.detail > 1 || isEditing) {
          return
        }
        onSelect?.()
      }}
      onKeyDown={(e) => {
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
        holdsOpenAgent ? 'bg-row-selected-weak' : active ? 'bg-row-selected' : 'hover:bg-row-hover',
        className,
      )}
    >
      <div className="flex flex-col gap-1 py-0.5 pr-0.5 pl-1.5">
        <div className="flex h-5 items-center gap-1.5 overflow-hidden">
          <Gutter>
            <SessionStatusIcon row={row} />
          </Gutter>
          {isEditing && onRename ? (
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
          <ContextRing usage={info.contextUsage} size={16} className="p-0.5" />
        </div>

        <div className="flex h-5 items-center gap-1.5 overflow-hidden text-body-sm tracking-[-0.005em]">
          <Gutter>
            <EngineIcon engine={engine} model={info.model} className={cn('size-4', vendorMarkClass(engine, info.model))} />
          </Gutter>
          <span className="min-w-0 truncate text-fg-4">
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

function Gutter({ children }: { children: ReactNode }) {
  return <span className="flex size-4 shrink-0 items-center justify-center">{children}</span>
}

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
        // Guarded on `document.hasFocus()`: selecting a session focuses another surface (in the extension, another view), and an unguarded blur closes the editor in the frame it appeared.
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
      className={cn(
        '-my-0.5 min-w-0 flex-1 rounded-sm border border-ring bg-bg px-1 py-px',
        'text-body-sm leading-5 text-fg-1 outline-none',
      )}
    />
  )
}

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Filter, X } from 'lucide-react'
import { STATE_LABELS, STATE_ORDER, adaptersOf, facetFilterCount, orderedGroupBy, projectsOf, resetGroupOrder } from '@workerdeck/protocol'
import type { GroupBy, SessionRow, SessionState, SortBy, ViewConfig, WorkspaceScope } from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover.tsx'
import { OptionSelect, Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export type SessionFiltersProps = {
  config: ViewConfig
  onConfigChange: (config: ViewConfig) => void
  rows: readonly SessionRow[]
  scope?: WorkspaceScope
  gateways?: readonly { id: string; name: string }[]
  className?: string
}

export function SessionFilters({ config, onConfigChange, rows, scope, gateways: gatewaysProp, className }: SessionFiltersProps) {
  const adapters = useMemo(() => adaptersOf(rows), [rows])
  const projects = useMemo(() => projectsOf(rows), [rows])
  const gateways = useMemo(() => {
    if (gatewaysProp) {
      return gatewaysProp
    }
    const seen = new Map<string, string>()
    for (const row of rows) {
      seen.set(row.hostId, row.hostName)
    }
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [rows, gatewaysProp])

  const set = (patch: Partial<ViewConfig>) => onConfigChange({ ...config, ...patch })

  return (
    <div data-slot="session-filters" className={cn('flex flex-col gap-3', className)}>
      <Section title="Filter">
        {scope ? (
          <FilterRow label="Scope">
            <OptionSelect
              className="w-full min-w-0"
              label="Scope"
              value={config.scoped ? 'scoped' : 'all'}
              options={[
                { value: 'scoped', label: scope.label },
                { value: 'all', label: 'All folders' },
              ]}
              onChange={(value) => set({ scoped: value === 'scoped' })}
            />
          </FilterRow>
        ) : null}
        <FilterRow label="State">
          <FacetSelect
            label="State"
            value={config.states}
            options={STATE_ORDER.map((s) => ({ value: s, label: STATE_LABELS[s] }))}
            onChange={(states) => set({ states: states as SessionState[] })}
          />
        </FilterRow>
        {adapters.length > 1 ? (
          <FilterRow label="Engine">
            <FacetSelect
              label="Engine"
              value={config.adapters}
              options={adapters.map((a) => ({ value: a, label: a }))}
              onChange={(next) => set({ adapters: next })}
            />
          </FilterRow>
        ) : null}
        {gateways.length > 1 ? (
          <FilterRow label="Gateway">
            <FacetSelect
              label="Gateway"
              value={config.gateways}
              options={gateways.map((g) => ({ value: g.id, label: g.name }))}
              onChange={(next) => set({ gateways: next })}
            />
          </FilterRow>
        ) : null}
        {projects.length > 1 ? (
          <FilterRow label="Project">
            <FacetSelect
              label="Project"
              value={config.projects ?? []}
              options={projects.map((p) => ({ value: p.key, label: p.label }))}
              onChange={(next) => set({ projects: next })}
            />
          </FilterRow>
        ) : null}
      </Section>

      <Section title="Layout">
        <FilterRow label="Group">
          <OptionSelect
            className="w-full min-w-0"
            label="Group"
            value={config.groupBy}
            options={[
              { value: 'none', label: 'No grouping' },
              { value: 'state', label: 'By state' },
              { value: 'adapter', label: 'By engine' },
              { value: 'project', label: gateways.length > 1 ? 'By gateway & project' : 'By project' },
              { value: 'custom', label: 'Custom' },
            ]}
            onChange={(groupBy) => set({ groupBy: groupBy as GroupBy })}
          />
        </FilterRow>
        {orderedGroupBy(config.groupBy) && config.groupOrder?.[config.groupBy]?.length ? (
          <button
            type="button"
            className="self-end text-label text-fg-3 underline underline-offset-2 hover:text-fg-1"
            onClick={() => onConfigChange(resetGroupOrder(config))}
          >
            Reset group order
          </button>
        ) : null}
        <FilterRow label="Sort">
          <OptionSelect
            className="w-full min-w-0"
            label="Sort"
            value={config.sortBy}
            options={[
              { value: 'recent', label: 'Recent' },
              { value: 'name', label: 'Name' },
              { value: 'state', label: 'State' },
              ...(projects.length > 1 ? [{ value: 'project' as const, label: 'Project' }] : []),
              ...(gateways.length > 1 ? [{ value: 'gateway' as const, label: 'Gateway' }] : []),
            ]}
            onChange={(sortBy) => set({ sortBy: sortBy as SortBy })}
          />
        </FilterRow>
      </Section>
    </div>
  )
}

export type SessionFiltersButtonProps = SessionFiltersProps & {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function SessionFiltersButton({ open, onOpenChange, className, ...props }: SessionFiltersButtonProps) {
  const count = facetFilterCount(props.config)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={count > 0 ? `Filters (${count} active)` : 'Filters'}
            title={count > 0 ? `${count} filter${count === 1 ? '' : 's'} active` : 'Filters'}
            className={className}
          >
            <Filter className={cn('size-3.5', count > 0 && 'fill-current text-fg-1')} />
          </Button>
        }
      />
      <PopoverContent className="w-80">
        <SessionFilters {...props} />
      </PopoverContent>
    </Popover>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-label font-medium uppercase tracking-wide text-fg-4">{title}</div>
      {children}
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="w-16 shrink-0 truncate text-label text-fg-3">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string[]
  options: { value: string; label: string }[]
  onChange: (value: string[]) => void
}) {
  return (
    <div className="flex items-center gap-1">
      <Select multiple value={value} onValueChange={(v) => onChange(v as string[])}>
        <SelectTrigger aria-label={label} className="min-w-0 flex-1">
          <SelectValue>
            {value.length === 0
              ? 'All'
              : value.length === 1
                ? (options.find((o) => o.value === value[0])?.label ?? 'All')
                : `${value.length} selected`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <SelectItemText>{option.label}</SelectItemText>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.length > 0 ? (
        <Button variant="ghost" size="icon-sm" aria-label={`Clear ${label}`} onClick={() => onChange([])}>
          <X className="size-3 text-fg-4" />
        </Button>
      ) : null}
    </div>
  )
}

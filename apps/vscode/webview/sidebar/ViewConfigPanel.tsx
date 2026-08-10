import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  cn,
} from '@workerdeck/ui'
import { Filter, X } from 'lucide-react'
import type { WireHost, WorkspaceScope } from '../../src/bridge-protocol.ts'
import {
  STATE_LABELS,
  STATE_ORDER,
  clearFilters,
  isFiltering,
  type GroupBy,
  type SortBy,
  type ViewConfig,
} from '../../src/view-config.ts'

const GROUP_LABELS: Record<GroupBy, string> = {
  none: 'None',
  gateway: 'Gateway',
  adapter: 'Adapter',
  state: 'State',
}

const SORT_LABELS: Record<SortBy, string> = {
  recent: 'Recent',
  name: 'Name',
  gateway: 'Gateway',
  adapter: 'Adapter',
  state: 'State',
}

/**
 * Everything that decides what the list shows: search, the facet filters, and
 * the group/sort choices — every one of them a dropdown on the right of its
 * label, because a sidebar this narrow cannot spend its width on chip rows that
 * wrap. A multi-select with nothing chosen means "all", which is why there is no
 * All entry to keep in sync with the rest of the list.
 *
 * The shape is the Extensions view's: a **search box that is always there**,
 * with the facets one click behind a funnel beside it. The funnel carries a dot
 * whenever a facet is hiding rows — this list is scoped by default, so a control
 * that is itself hidden would leave no sign of why the list is short. Expanded,
 * the facets are a settings sheet (label left, control right, one row each) on
 * the section-header surface VS Code uses for exactly this.
 */
export function ViewConfigPanel({
  config,
  hosts,
  adapters,
  scope,
  open,
  onOpenChange,
  onChange,
}: {
  config: ViewConfig
  hosts: readonly WireHost[]
  adapters: readonly string[]
  scope: WorkspaceScope | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (next: ViewConfig) => void
}) {
  const set = <K extends keyof ViewConfig>(key: K, value: ViewConfig[K]) =>
    onChange({ ...config, [key]: value })
  const facets = facetCount(config, scope)

  return (
    <div className='shrink-0 border-b border-border'>
      {/* The search row is always there and always usable, with the facets one
          click behind the funnel — the shape VS Code's own Extensions view uses.
          It lives in this webview because that native row is workbench chrome:
          a view title can hold commands, never an input. */}
      <div className='flex items-center gap-1 px-2 py-1.5'>
        <div className='relative min-w-0 flex-1'>
          <Input
            value={config.search}
            onChange={(e) => set('search', e.target.value)}
            placeholder='Search sessions'
            className='h-6 w-full pr-6 text-body-sm'
          />
          {config.search ? (
            <button
              type='button'
              aria-label='Clear search'
              onClick={() => set('search', '')}
              className='absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-4 hover:text-fg-1'>
              <X className='size-3' />
            </button>
          ) : null}
        </div>
        <button
          type='button'
          aria-expanded={open}
          aria-label='Filter, group and sort sessions'
          title='Filter, group and sort sessions'
          onClick={() => onOpenChange(!open)}
          className={cn(
            'relative shrink-0 rounded p-1 outline-none transition-colors hover:bg-surface-hover',
            open ? 'bg-surface-hover text-fg-1' : 'text-fg-3 hover:text-fg-1',
          )}>
          <Filter className='size-3.5' />
          {/* A facet is narrowing the list even when this is collapsed — the
              list hides rows by default, so the funnel has to say so. */}
          {facets > 0 ? (
            <span className='absolute right-0.5 top-0.5 size-1.5 rounded-full bg-(--vscode-activityBarBadge-background,var(--accent))' />
          ) : null}
        </button>
      </div>

      {open ? (
        <div className='flex flex-col gap-1 border-t border-border bg-(--vscode-sideBarSectionHeader-background,var(--bg-surface)) px-2 py-1.5'>
          {/* Only where there is a folder to be inside of — an inert control in a
              folderless window would be one that does nothing. Single-select:
              the list is either scoped to this window or it isn't. */}
          {scope ? (
            <Row label='Scope'>
              <OneOf
                value={config.scoped ? 'scoped' : 'all'}
                options={[
                  { value: 'scoped', label: scope.label },
                  { value: 'all', label: 'All folders' },
                ]}
                onChange={(v) => set('scoped', v === 'scoped')}
              />
            </Row>
          ) : null}

          {hosts.length > 1 ? (
            <Row label='Gateway'>
              <AnyOf
                values={config.gateways}
                options={hosts.map((host) => ({ value: host.id, label: host.name }))}
                onChange={(v) => set('gateways', v)}
              />
            </Row>
          ) : null}

          {adapters.length > 1 ? (
            <Row label='Adapter'>
              <AnyOf
                values={config.adapters}
                options={adapters.map((adapter) => ({ value: adapter, label: adapter }))}
                onChange={(v) => set('adapters', v)}
              />
            </Row>
          ) : null}

          <Row label='State'>
            <AnyOf
              values={config.states}
              options={STATE_ORDER.map((state) => ({ value: state, label: STATE_LABELS[state] }))}
              onChange={(v) => set('states', v)}
            />
          </Row>

          <Row label='Group'>
            <OneOf
              value={config.groupBy}
              options={labelledOptions(GROUP_LABELS)}
              onChange={(v) => set('groupBy', v)}
            />
          </Row>
          <Row label='Sort'>
            <OneOf
              value={config.sortBy}
              options={labelledOptions(SORT_LABELS)}
              onChange={(v) => set('sortBy', v)}
            />
          </Row>

          {isFiltering(config, scope) ? (
            <div className='flex justify-end pt-0.5'>
              <button
                type='button'
                onClick={() => onChange(clearFilters(config))}
                className='text-label text-fg-4 underline-offset-2 hover:text-fg-1 hover:underline'>
                Clear filters
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** How many facets are narrowing the list — what the funnel's dot reports.
 * Search is excluded on purpose: it has its own always-visible box, so counting
 * it would put a marker on the control that isn't doing the hiding. */
function facetCount(config: ViewConfig, scope: WorkspaceScope | undefined): number {
  return (
    (config.scoped && scope ? 1 : 0) +
    (config.gateways.length ? 1 : 0) +
    (config.adapters.length ? 1 : 0) +
    (config.states.length ? 1 : 0)
  )
}

type Option<T extends string> = { value: T; label: string }

function labelledOptions<T extends string>(labels: Record<T, string>): Option<T>[] {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }))
}

/** One settings row: label left, control right. The label column is fixed so
 * every control starts on the same edge — the sidebar is too narrow to let them
 * drift. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex items-center gap-2 py-0.5'>
      <span className='w-12 shrink-0 text-label text-fg-4'>{label}</span>
      <div className='min-w-0 flex-1'>{children}</div>
    </div>
  )
}

/** Pick exactly one. */
function OneOf<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className='h-6 w-full min-w-0 text-body-sm'>
        {/* The popup is portalled and mounted lazily, so Base UI has no item
            label to resolve the value against — name it explicitly. */}
        <SelectValue className='truncate'>
          {(v) => options.find((o) => o.value === v)?.label ?? String(v)}
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
  )
}

/**
 * Pick any number, none meaning all. The trigger names one or two choices and
 * counts beyond that — a sidebar-width trigger listing five states would just
 * truncate, which says less than "3 selected".
 */
function AnyOf<T extends string>({
  values,
  options,
  onChange,
}: {
  values: readonly T[]
  options: readonly Option<T>[]
  onChange: (values: T[]) => void
}) {
  return (
    <Select multiple value={values as T[]} onValueChange={(v) => onChange(v as T[])}>
      <SelectTrigger className='h-6 w-full min-w-0 text-body-sm'>
        <SelectValue className='truncate'>
          {(v) => {
            const chosen = Array.isArray(v) ? (v as T[]) : []
            if (chosen.length === 0) return 'All'
            const labels = chosen.map((c) => options.find((o) => o.value === c)?.label ?? c)
            return labels.length <= 2 ? labels.join(', ') : `${labels.length} selected`
          }}
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
  )
}

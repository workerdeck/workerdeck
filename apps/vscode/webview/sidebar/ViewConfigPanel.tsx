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
import { X } from 'lucide-react'
import type { WireHost, WorkspaceScope } from '../../src/bridge-protocol.ts'
import {
  STATE_LABELS,
  STATE_ORDER,
  clearFilters,
  isFiltering,
  toggleFilter,
  type GroupBy,
  type SortBy,
  type ViewConfig,
} from './view-config.ts'

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
 * Everything that decides what the list shows, behind the header's one toggle:
 * search, the three facet filters, and the group/sort choices. Filters are
 * multi-select chips — an empty selection means "all", which is why there is an
 * explicit All chip rather than a checked/unchecked set to reason about.
 */
export function ViewConfigPanel({
  config,
  hosts,
  adapters,
  scope,
  onChange,
}: {
  config: ViewConfig
  hosts: readonly WireHost[]
  adapters: readonly string[]
  scope: WorkspaceScope | undefined
  onChange: (next: ViewConfig) => void
}) {
  const set = <K extends keyof ViewConfig>(key: K, value: ViewConfig[K]) =>
    onChange({ ...config, [key]: value })

  return (
    <div className='flex flex-col gap-2 border-b border-border px-2 pb-2'>
      <div className='relative'>
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

      {/* Only where there is a folder to be inside of — an inert chip pair in a
          folderless window would be a control that does nothing. */}
      {scope ? (
        <ChipRow label='Scope'>
          <Chip active={config.scoped} onClick={() => set('scoped', true)}>
            {scope.label}
          </Chip>
          <Chip active={!config.scoped} onClick={() => set('scoped', false)}>
            All folders
          </Chip>
        </ChipRow>
      ) : null}

      {hosts.length > 1 ? (
        <ChipRow label='Gateway'>
          <Chip active={config.gateways.length === 0} onClick={() => set('gateways', [])}>
            All
          </Chip>
          {hosts.map((host) => (
            <Chip
              key={host.id}
              active={config.gateways.includes(host.id)}
              onClick={() => set('gateways', toggleFilter(config.gateways, host.id))}>
              {host.name}
            </Chip>
          ))}
        </ChipRow>
      ) : null}

      {adapters.length > 1 ? (
        <ChipRow label='Adapter'>
          <Chip active={config.adapters.length === 0} onClick={() => set('adapters', [])}>
            All
          </Chip>
          {adapters.map((adapter) => (
            <Chip
              key={adapter}
              active={config.adapters.includes(adapter)}
              onClick={() => set('adapters', toggleFilter(config.adapters, adapter))}>
              {adapter}
            </Chip>
          ))}
        </ChipRow>
      ) : null}

      <ChipRow label='State'>
        <Chip active={config.states.length === 0} onClick={() => set('states', [])}>
          All
        </Chip>
        {STATE_ORDER.map((state) => (
          <Chip
            key={state}
            active={config.states.includes(state)}
            onClick={() => set('states', toggleFilter(config.states, state))}>
            {STATE_LABELS[state]}
          </Chip>
        ))}
      </ChipRow>

      <div className='flex items-center gap-1'>
        <Facet
          label='Group'
          value={config.groupBy}
          labels={GROUP_LABELS}
          onChange={(v) => set('groupBy', v)}
        />
        <Facet
          label='Sort'
          value={config.sortBy}
          labels={SORT_LABELS}
          onChange={(v) => set('sortBy', v)}
        />
      </div>

      {isFiltering(config, scope) ? (
        <button
          type='button'
          onClick={() => onChange(clearFilters(config))}
          className='self-start text-label text-fg-4 underline-offset-2 hover:text-fg-1 hover:underline'>
          Clear filters
        </button>
      ) : null}
    </div>
  )
}

function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-label uppercase tracking-wide text-fg-4'>{label}</span>
      <div className='flex flex-wrap gap-1'>{children}</div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-1.5 py-px text-label transition-colors',
        active
          ? 'border-transparent bg-(--vscode-button-background,var(--accent)) text-(--vscode-button-foreground,white)'
          : 'border-border text-fg-3 hover:border-border-strong hover:text-fg-1',
      )}>
      {children}
    </button>
  )
}

function Facet<T extends string>({
  label,
  value,
  labels,
  onChange,
}: {
  label: string
  value: T
  labels: Record<T, string>
  onChange: (value: T) => void
}) {
  return (
    <label className='flex min-w-0 flex-1 items-center gap-1 text-label text-fg-4'>
      {label}
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger className='h-6 min-w-0 flex-1 text-body-sm'>
          {/* The popup is portalled and mounted lazily, so Base UI has no item
              label to resolve the value against — name it explicitly. */}
          <SelectValue className='truncate'>{(v) => labels[v as T]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(labels) as T[]).map((key) => (
            <SelectItem key={key} value={key}>
              <SelectItemText>{labels[key]}</SelectItemText>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

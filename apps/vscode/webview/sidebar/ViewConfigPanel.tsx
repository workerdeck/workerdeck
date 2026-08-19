import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@workerdeck/ui'
import { X } from 'lucide-react'
import type { WireHost, WorkspaceScope } from '../../src/bridge-protocol.ts'
import {
  STATE_LABELS,
  STATE_ORDER,
  type GroupBy,
  type SortBy,
  type ViewConfig,
} from '../../src/view-config.ts'

const GROUP_LABELS: Record<GroupBy, string> = {
  none: 'None',
  gateway: 'Gateway',
  adapter: 'Adapter',
  state: 'State',
  project: 'Project',
}

const SORT_LABELS: Record<SortBy, string> = {
  recent: 'Recent',
  name: 'Name',
  gateway: 'Gateway',
  adapter: 'Adapter',
  state: 'State',
  project: 'Project',
}

/**
 * Everything that decides what the list shows: search, the facet filters, and
 * the group/sort choices — every one of them a dropdown on the right of its
 * label, because a sidebar this narrow cannot spend its width on chip rows that
 * wrap. A multi-select with nothing chosen means "all", which is why there is no
 * All entry to keep in sync with the rest of the list.
 *
 * Revealed by a **native view-title toggle**, not a control of its own. A
 * toggle whose icon must visibly differ open vs. closed is a pair of commands
 * gated on a context key, and commands live in the title bar — so the host owns
 * the boolean and this panel simply is or is not mounted. That also frees the
 * list of a permanent control row: a sidebar this narrow should spend its width
 * on sessions until asked otherwise.
 *
 * Search sits at the top because it is what people reach for; the facets follow
 * as a settings sheet (label left, control right, one row each) on the
 * section-header surface VS Code uses for exactly this.
 */
export function ViewConfigPanel({
  config,
  hosts,
  adapters,
  projects,
  scope,
  onChange,
}: {
  config: ViewConfig
  hosts: readonly WireHost[]
  adapters: readonly string[]
  /** `{ key, label }` from protocol's `projectsOf` — key, because a name is not
   * a key (two repos are both called "api"). */
  projects: readonly { key: string; label: string }[]
  scope: WorkspaceScope | undefined
  onChange: (next: ViewConfig) => void
}) {
  const set = <K extends keyof ViewConfig>(key: K, value: ViewConfig[K]) =>
    onChange({ ...config, [key]: value })

  return (
    <div className='shrink-0 border-b border-border'>
      {/* Search leads: it is what people reach for, and unlike the facets it
          needs no explaining. */}
      <div className='px-2 pb-1 pt-1.5'>
        <div className='relative'>
          <Input
            value={config.search}
            onChange={(e) => set('search', e.target.value)}
            placeholder='Search sessions'
            className='h-6 w-full pr-6 text-body-sm'
            autoFocus
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
      </div>

      <div className='flex flex-col gap-1 px-2 pb-1.5'>
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

        {projects.length > 1 ? (
          <Row label='Project'>
            <AnyOf
              values={config.projects ?? []}
              options={projects.map((p) => ({ value: p.key, label: p.label }))}
              onChange={(v) => set('projects', v)}
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
        {/* No "clear filters" here: the subset line below already carries the
            one way out, and two of them is how the old design ended up with two
            competing signals in the first place. */}
      </div>
    </div>
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

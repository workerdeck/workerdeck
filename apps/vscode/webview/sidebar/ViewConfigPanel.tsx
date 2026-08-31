import { Input, Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '@workerdeck/ui'
import { X } from 'lucide-react'
import type { WireHost, WorkspaceScope } from '../../src/bridge-protocol.ts'
import { STATE_LABELS, STATE_ORDER, type GroupBy, type SortBy, type ViewConfig } from '../../src/view-config.ts'

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
  // Keyed, not named: two repos are both called "api" (protocol's `projectsOf`).
  projects: readonly { key: string; label: string }[]
  scope: WorkspaceScope | undefined
  onChange: (next: ViewConfig) => void
}) {
  const set = <K extends keyof ViewConfig>(key: K, value: ViewConfig[K]) => onChange({ ...config, [key]: value })

  return (
    <div className="shrink-0 border-b border-border">
      <div className="px-2 pb-1 pt-1.5">
        <div className="relative">
          <Input
            value={config.search}
            onChange={(e) => set('search', e.target.value)}
            placeholder="Search sessions"
            className="h-6 w-full pr-6 text-body-sm"
            autoFocus
          />
          {config.search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => set('search', '')}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-4 hover:text-fg-1"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1 px-2 pb-1.5">
        {scope ? (
          <Row label="Scope">
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
          <Row label="Gateway">
            <AnyOf
              values={config.gateways}
              options={hosts.map((host) => ({ value: host.id, label: host.name }))}
              onChange={(v) => set('gateways', v)}
            />
          </Row>
        ) : null}

        {adapters.length > 1 ? (
          <Row label="Adapter">
            <AnyOf
              values={config.adapters}
              options={adapters.map((adapter) => ({ value: adapter, label: adapter }))}
              onChange={(v) => set('adapters', v)}
            />
          </Row>
        ) : null}

        {projects.length > 1 ? (
          <Row label="Project">
            <AnyOf
              values={config.projects ?? []}
              options={projects.map((p) => ({ value: p.key, label: p.label }))}
              onChange={(v) => set('projects', v)}
            />
          </Row>
        ) : null}

        <Row label="State">
          <AnyOf
            values={config.states}
            options={STATE_ORDER.map((state) => ({ value: state, label: STATE_LABELS[state] }))}
            onChange={(v) => set('states', v)}
          />
        </Row>

        <Row label="Group">
          <OneOf value={config.groupBy} options={labelledOptions(GROUP_LABELS)} onChange={(v) => set('groupBy', v)} />
        </Row>
        <Row label="Sort">
          <OneOf value={config.sortBy} options={labelledOptions(SORT_LABELS)} onChange={(v) => set('sortBy', v)} />
        </Row>
      </div>
    </div>
  )
}

type Option<T extends string> = { value: T; label: string }

function labelledOptions<T extends string>(labels: Record<T, string>): Option<T>[] {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }))
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-12 shrink-0 text-label text-fg-4">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function OneOf<T extends string>({ value, options, onChange }: { value: T; options: readonly Option<T>[]; onChange: (value: T) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className="h-6 w-full min-w-0 text-body-sm">
        {/* The popup is portalled and mounted lazily, so Base UI has no item label to
            resolve the value against — name it explicitly. */}
        <SelectValue className="truncate">{(v) => options.find((o) => o.value === v)?.label ?? String(v)}</SelectValue>
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
      <SelectTrigger className="h-6 w-full min-w-0 text-body-sm">
        <SelectValue className="truncate">
          {(v) => {
            const chosen = Array.isArray(v) ? (v as T[]) : []
            if (chosen.length === 0) {
              return 'All'
            }
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

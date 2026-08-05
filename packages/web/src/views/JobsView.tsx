import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type {
  JobInfo,
  JobStatus,
  PermissionMode,
  QuestionBehavior,
  QueueStats,
} from '@workerdeck/protocol'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  PermissionModeSelect,
  QUESTION_BEHAVIORS,
  ProgressRing,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  formatCost,
  formatRelativeTime,
  formatTokens,
  toast,
  type BadgeProps,
} from '@workerdeck/ui'
import { CalendarClock, Eye, ListChecks, Plus, RefreshCw, X } from 'lucide-react'
import { ModelPicker } from '@/components/ModelPicker.tsx'
import { ProfileSelect } from '@/components/ProfileSelect.tsx'
import { client } from '@/lib/client.ts'
import { engineFormOptions } from '@/lib/engine.ts'
import { getDefaultModel, getDefaultPermissionMode } from '@/lib/settings.ts'
import { useJobs } from '@/lib/useJobs.ts'
import { useProfileChoice } from '@/lib/useProfiles.ts'
import { useSessions } from '@/lib/useSessions.ts'

const CWD_KEY = 'workerdeck.last-cwd'

const JOB_STATUS_META: Record<JobStatus, { label: string; variant: BadgeProps['variant']; busy?: boolean }> = {
  queued: { label: 'Queued', variant: 'neutral' },
  running: { label: 'Running', variant: 'info', busy: true },
  // Waiting on an external execution: still live, but nothing is burning here.
  parked: { label: 'Parked', variant: 'accent' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  canceled: { label: 'Canceled', variant: 'warning' },
}

function QueueStatsStrip({ stats }: { stats: QueueStats }) {
  const dailyPct =
    stats.dailyTokenLimit !== undefined && stats.dailyTokenLimit > 0
      ? (stats.dailyTokensUsed / stats.dailyTokenLimit) * 100
      : undefined
  return (
    <div className='flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-surface px-3 py-2 text-body-sm text-fg-2'>
      <span>
        Running <span className='font-mono text-fg-1'>{stats.running}/{stats.maxConcurrency}</span>
      </span>
      <span>
        Queued <span className='font-mono text-fg-1'>{stats.queued}</span>
      </span>
      {/* Only worth the space once something is actually waiting on an external
          execution — most deployments never defer at all. */}
      {stats.parked > 0 ? (
        <span>
          Parked <span className='font-mono text-fg-1'>{stats.parked}</span>
        </span>
      ) : null}
      <span className='inline-flex items-center gap-1.5'>
        {dailyPct !== undefined ? (
          <ProgressRing
            value={dailyPct}
            className={dailyPct >= 95 ? 'text-danger' : dailyPct >= 80 ? 'text-warning' : 'text-fg-3'}
          />
        ) : null}
        Daily tokens{' '}
        <span className='font-mono text-fg-1'>
          {formatTokens(stats.dailyTokensUsed)}
          {stats.dailyTokenLimit !== undefined ? ` / ${formatTokens(stats.dailyTokenLimit)}` : ''}
        </span>
      </span>
      {stats.sessionTokenLimit !== undefined ? (
        <span>
          Per-job cap <span className='font-mono text-fg-1'>{formatTokens(stats.sessionTokenLimit)}</span>
        </span>
      ) : null}
      {stats.paused ? (
        <Badge variant='warning' dot>
          Paused — daily budget exhausted
        </Badge>
      ) : null}
    </div>
  )
}

function ScheduleJobCard({ onScheduled }: { onScheduled: () => void }) {
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) ?? '')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<PermissionMode>(() => getDefaultPermissionMode('job'))
  const [questions, setQuestions] = useState<QuestionBehavior>('auto')
  const [model, setModel] = useState(() => getDefaultModel('job'))
  const [effort, setEffort] = useState('')
  const { profiles, profile, selected, select: selectProfile } = useProfileChoice()
  const engine = engineFormOptions(selected, mode, model)
  const [allowBypass, setAllowBypass] = useState(false)
  const [maxTokens, setMaxTokens] = useState('')
  const [attempts, setAttempts] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [creating, setCreating] = useState(false)

  const schedule = async () => {
    if (!cwd.trim() || !prompt.trim()) {
      toast.error('Working directory and prompt are required')
      return
    }
    const tokens = maxTokens.trim() ? Number(maxTokens.trim()) : undefined
    if (tokens !== undefined && (!Number.isFinite(tokens) || tokens <= 0)) {
      toast.error('Max tokens must be a positive number')
      return
    }
    const attemptCount = attempts.trim() ? Number(attempts.trim()) : undefined
    if (attemptCount !== undefined && (!Number.isInteger(attemptCount) || attemptCount < 1)) {
      toast.error('Attempts must be a whole number of at least 1')
      return
    }
    setCreating(true)
    try {
      localStorage.setItem(CWD_KEY, cwd.trim())
      await client.createJob({
        session: {
          cwd: cwd.trim(),
          profile: profile || undefined,
          prompt: prompt.trim(),
          permissionMode: engine.mode,
          // Meaningless without an approval channel — the record decides.
          questionBehavior: engine.capabilities.interactiveApprovals ? questions : undefined,
          model: engine.model.trim() || undefined,
          reasoningEffort:
            effort && engine.reasoningEfforts.includes(effort) ? effort : undefined,
          // CLI spawn options, offered when the record says they apply. Opt-in
          // per job: pre-authorize bypassPermissions so someone watching the
          // run can switch it on mid-run. Off by default for unattended runs.
          ...(engine.capabilities.settingSources
            ? {
                settingSources: ['user' as const, 'project' as const],
                allowDangerouslySkipPermissions: allowBypass || undefined,
              }
            : {}),
        },
        maxTokens: tokens,
        attempts: attemptCount,
        webhook: webhookUrl.trim() ? { url: webhookUrl.trim() } : undefined,
      })
      setPrompt('')
      toast.success('Job scheduled')
      onScheduled()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to schedule job')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedule a job</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        <label className='flex flex-col gap-1'>
          <span className='text-label font-medium text-fg-3'>Working directory</span>
          <Input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder='/path/to/project'
            spellCheck={false}
            className='font-mono'
          />
        </label>
        <label className='flex flex-col gap-1'>
          <span className='text-label font-medium text-fg-3'>Prompt (the task — runs unattended)</span>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder='e.g. /verify-content 42, or a task description'
          />
        </label>
        <div className='flex flex-wrap items-end gap-3'>
          <ProfileSelect
            profiles={profiles}
            value={profile}
            onChange={selectProfile}
            className='min-w-32'
          />
          <label className='flex min-w-0 flex-col gap-1'>
            <span className='text-label font-medium text-fg-3'>Permission mode</span>
            <PermissionModeSelect
              variant='form'
              mode={engine.mode}
              onModeChange={setMode}
              modes={engine.modes}
              className='min-w-44'
            />
          </label>
          {/* Questions ride the approval channel; without one there is nothing
              to configure. */}
          {engine.capabilities.interactiveApprovals ? (
            <label className='flex min-w-0 flex-col gap-1'>
              <span className='text-label font-medium text-fg-3'>Questions</span>
              <Select
                items={QUESTION_BEHAVIORS.map((b) => ({ value: b.value, label: b.label }))}
                value={questions}
                onValueChange={(value) => setQuestions(value as QuestionBehavior)}>
                <SelectTrigger className='min-w-36'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUESTION_BEHAVIORS.map((b) => (
                    <SelectItem key={b.value} value={b.value}>
                      <SelectItemText>{`${b.label} — ${b.description}`}</SelectItemText>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <label className='flex min-w-0 flex-col gap-1'>
            <span className='text-label font-medium text-fg-3'>Model</span>
            <ModelPicker
              value={engine.model}
              onChange={setModel}
              models={engine.models}
              className='min-w-40'
            />
          </label>
          {engine.reasoningEfforts.length > 0 ? (
            <label className='flex min-w-0 flex-col gap-1'>
              <span className='text-label font-medium text-fg-3'>Effort</span>
              <Select
                items={[
                  { value: 'default', label: 'Default' },
                  ...engine.reasoningEfforts.map((e) => ({ value: e, label: e })),
                ]}
                value={effort || 'default'}
                onValueChange={(value) => setEffort(value === 'default' ? '' : String(value))}>
                <SelectTrigger className='min-w-28'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['default', ...engine.reasoningEfforts].map((e) => (
                    <SelectItem key={e} value={e}>
                      <SelectItemText>{e}</SelectItemText>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <label className='flex min-w-0 flex-col gap-1'>
            <span className='text-label font-medium text-fg-3'>Max tokens (optional)</span>
            <Input
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder='per-job cap'
              inputMode='numeric'
              className='min-w-28 font-mono'
            />
          </label>
          <label className='flex min-w-0 flex-col gap-1'>
            <span className='text-label font-medium text-fg-3'>Attempts (optional)</span>
            <Input
              value={attempts}
              onChange={(e) => setAttempts(e.target.value)}
              placeholder='1'
              inputMode='numeric'
              className='min-w-20 font-mono'
            />
          </label>
          <label className='flex min-w-0 flex-1 flex-col gap-1'>
            <span className='text-label font-medium text-fg-3'>Webhook URL (optional)</span>
            <Input
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder='https://…/hook'
              spellCheck={false}
              className='min-w-44 font-mono'
            />
          </label>
          <Button onClick={() => void schedule()} disabled={creating}>
            {creating ? <Spinner className='size-3.5 text-current' /> : <Plus className='size-4' />}
            Schedule
          </Button>
        </div>
        {/* The capability is a CLI spawn flag; the record says where it applies. */}
        {!engine.capabilities.settingSources ? null : (
          <label
            className='flex w-fit cursor-pointer items-center gap-2 text-body-sm text-fg-2'
            title='Spawns the CLI with --dangerously-skip-permissions available, so the mode can be switched on while watching the run. The job still starts in the mode selected above.'>
            <input
              type='checkbox'
              checked={allowBypass}
              onChange={(e) => setAllowBypass(e.target.checked)}
              className='size-3.5 accent-(--color-fg-1)'
            />
            Allow switching to <code className='font-mono'>bypassPermissions</code> mid-run
            <span className='text-label text-fg-4'>(dangerous)</span>
          </label>
        )}
        <p className='text-label text-fg-4'>
          Unattended runs still surface permission prompts — watch the job&apos;s session to
          approve, or pick a mode that doesn&apos;t ask. Unanswered prompts deny after the
          server&apos;s timeout. With Questions set to Ask, webhook deliveries carry the full
          question so a controller can answer via{' '}
          <code className='font-mono'>POST /sessions/:id/permissions/:requestId</code>.
        </p>
      </CardContent>
    </Card>
  )
}

function JobRow({
  job,
  watchable,
  onChanged,
}: {
  job: JobInfo
  /** The job's session is still in the registry (attachable for live view / replay). */
  watchable: boolean
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const meta = JOB_STATUS_META[job.status]
  // Parked jobs are live too — cancelling one is how you abandon a wait.
  const cancellable = job.status === 'queued' || job.status === 'running' || job.status === 'parked'
  const cancel = async () => {
    try {
      await client.cancelJob(job.id)
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Cancel failed')
    }
  }
  return (
    <li className='flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-hover'>
      <Badge variant={meta.variant} dot={!meta.busy}>
        {meta.busy ? <Spinner className='size-3 text-current' /> : null}
        {meta.label}
      </Badge>
      <div className='min-w-0 flex-1'>
        <div className='truncate text-body-sm text-fg-1'>{job.prompt}</div>
        <div className='flex flex-wrap gap-x-3 font-mono text-label text-fg-4'>
          <span className='truncate'>{job.cwd}</span>
          {job.profile ? <span className='shrink-0'>@{job.profile}</span> : null}
          <span className='shrink-0'>{formatRelativeTime(job.finishedAt ?? job.startedAt ?? job.createdAt)}</span>
          {job.maxAttempts !== undefined && job.maxAttempts > 1 ? (
            <span className='shrink-0'>
              attempt {job.attempt ?? 1}/{job.maxAttempts}
              {job.status === 'queued' && job.nextRunAt !== undefined && job.nextRunAt > Date.now()
                ? ' — retry pending'
                : ''}
            </span>
          ) : null}
          {job.usage.tokens > 0 ? (
            <span className='shrink-0'>{formatTokens(job.usage.tokens)} tok</span>
          ) : null}
          {job.usage.totalCostUsd > 0 ? (
            <span className='shrink-0'>{formatCost(job.usage.totalCostUsd)}</span>
          ) : null}
          {job.error ? <span className='truncate text-danger'>{job.error}</span> : null}
        </div>
      </div>
      {job.sessionId && watchable ? (
        <Button
          variant='ghost'
          size='xs'
          onClick={() =>
            void navigate({ to: '/sessions/$sessionId', params: { sessionId: job.sessionId! } })
          }>
          <Eye className='size-3' />
          Watch
        </Button>
      ) : null}
      {cancellable ? (
        <Button variant='outline' size='xs' onClick={() => void cancel()}>
          <X className='size-3' />
          Cancel
        </Button>
      ) : null}
    </li>
  )
}

export function JobsView() {
  const { jobs, stats, enabled, live, error, refresh } = useJobs()
  // Watch is only offered while the job's session is still in the registry —
  // completed jobs' sessions can be deleted from the Sessions view.
  const { sessions } = useSessions()
  const liveSessionIds = new Set(sessions.map((s) => s.id))
  const sorted = [...jobs].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className='flex-1 overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6'>
        <header className='flex items-end justify-between'>
          <div>
            <h1 className='text-display-sm font-semibold tracking-tight text-text'>Jobs</h1>
            <p className='mt-0.5 text-body-sm text-muted-foreground'>
              Scheduled one-shot runs with concurrency and token budgets.
            </p>
          </div>
          <div className='flex items-center gap-2'>
            {enabled ? (
              <Badge variant={live ? 'success' : 'neutral'} dot>
                {live ? 'Live' : 'Polling'}
              </Badge>
            ) : null}
            <Button variant='ghost' size='icon-sm' aria-label='Refresh' onClick={() => void refresh()}>
              <RefreshCw className='size-4' />
            </Button>
          </div>
        </header>

        {error ? (
          <div className='rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger'>
            Can&apos;t reach the worker server: {error}. Start it with{' '}
            <code className='font-mono'>pnpm server</code>.
          </div>
        ) : null}

        {!enabled ? (
          <div className='flex flex-col items-center gap-2 rounded-md border border-border bg-surface px-4 py-8 text-center'>
            <CalendarClock className='size-6 text-fg-4' />
            <p className='text-body-sm text-fg-2'>The server has no job queue configured.</p>
            <p className='text-label text-fg-4'>
              Pass <code className='font-mono'>queue: {'{ maxConcurrency, … }'}</code> to{' '}
              <code className='font-mono'>createWorkerServer</code> — the dev server enables it by
              default.
            </p>
          </div>
        ) : (
          <>
            {stats ? <QueueStatsStrip stats={stats} /> : null}

            {sorted.length === 0 ? (
              <div className='flex flex-col items-center gap-2 rounded-md border border-border bg-surface px-4 py-8 text-center'>
                <ListChecks className='size-6 text-fg-4' />
                <p className='text-body-sm text-fg-2'>No jobs yet. Schedule one below.</p>
              </div>
            ) : (
              <ul className='flex flex-col gap-1 rounded-md border border-border bg-surface p-1'>
                {sorted.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    watchable={job.sessionId !== undefined && liveSessionIds.has(job.sessionId)}
                    onChanged={() => void refresh()}
                  />
                ))}
              </ul>
            )}

            <ScheduleJobCard onScheduled={() => void refresh()} />
          </>
        )}
      </div>
    </div>
  )
}

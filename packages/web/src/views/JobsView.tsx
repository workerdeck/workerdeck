import { useState } from 'react'
import type { QuestionBehavior, QueueStats } from '@workerdeck/protocol'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  Empty,
  EmptyKey,
  Input,
  QUESTION_BEHAVIORS,
  ProgressRing,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  Spinner,
  formatTokens,
  toast,
} from '@workerdeck/ui'
import { CalendarClock, ListChecks, Plus } from 'lucide-react'
import { RunFormFields, useRunForm } from '@/components/RunForm.tsx'
import { client } from '@/lib/client.ts'
import { primaryHost } from '@/lib/hosts.ts'
import { useJobs } from '@/hooks/useJobs.ts'
import { useSessions } from '@/hooks/useSessions.ts'

export function QueueStatsStrip({ stats }: { stats: QueueStats }) {
  const dailyPct =
    stats.dailyTokenLimit !== undefined && stats.dailyTokenLimit > 0
      ? (stats.dailyTokensUsed / stats.dailyTokenLimit) * 100
      : undefined
  return (
    <div className='flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-md border border-border bg-surface px-3 py-2 text-body-sm text-fg-2'>
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

function ScheduleJobForm({ onScheduled }: { onScheduled: () => void }) {
  // Jobs are the primary gateway's, so the cwd suggestions come from its
  // sessions — see `primaryClient()`.
  const { snapshots } = useSessions()
  const sessions = snapshots.find((snap) => snap.host.id === primaryHost()?.id)?.sessions ?? []
  const form = useRunForm('job')
  const [questions, setQuestions] = useState<QuestionBehavior>('auto')
  const [allowBypass, setAllowBypass] = useState(false)
  const [maxTokens, setMaxTokens] = useState('')
  const [attempts, setAttempts] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [creating, setCreating] = useState(false)
  const { engine } = form

  const schedule = async () => {
    if (!form.cwd.trim() || !form.prompt.trim()) {
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
      form.rememberCwd(form.cwd.trim())
      await client()!.createJob({
        session: {
          ...form.sessionFields({
            // Opt-in per job, unlike an interactive session: nobody is present
            // to make the call, so pre-authorizing it has to be deliberate.
            allowBypass,
          }),
          // Restated rather than passed through: a job's prompt is required (it
          // is the whole job), where a session's is optional.
          prompt: form.prompt.trim(),
          // Meaningless without an approval channel — the record decides.
          questionBehavior: engine.capabilities.interactiveApprovals ? questions : undefined,
        },
        maxTokens: tokens,
        attempts: attemptCount,
        webhook: webhookUrl.trim() ? { url: webhookUrl.trim() } : undefined,
      })
      form.setPrompt('')
      toast.success('Job scheduled')
      onScheduled()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to schedule job')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className='flex flex-col gap-3'>
      <RunFormFields
        form={form}
        sessions={sessions}
        promptLabel='Prompt (the task — runs unattended)'
        extras={
          // Questions ride the approval channel; without one there is nothing
          // to configure.
          engine.capabilities.interactiveApprovals ? (
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
          ) : null
        }
        actions={
          <>
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
            <Button className='ml-auto' onClick={() => void schedule()} disabled={creating}>
              {creating ? <Spinner className='size-3.5 text-current' /> : <Plus className='size-4' />}
              Schedule
            </Button>
          </>
        }
      />
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
        Unattended runs still surface permission prompts — the job&apos;s page is read-only, so
        answer them from the session itself, or pick a mode that doesn&apos;t ask. Unanswered
        prompts deny after the server&apos;s timeout. With Questions set to Ask, webhook
        deliveries carry the full question so a controller can answer via{' '}
        <code className='font-mono'>POST /sessions/:id/permissions/:requestId</code>.
      </p>
    </div>
  )
}

/** The `+` in the Jobs sidebar header opens this. */
export function ScheduleJobDialog({
  open,
  onOpenChange,
  onScheduled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onScheduled: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size='lg'>
        <DialogHeader
          title='Schedule a job'
          description='A one-shot run the queue executes unattended.'
        />
        <DialogBody>{open ? <ScheduleJobForm onScheduled={onScheduled} /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What fills the detail pane when no job is selected: the queue's own health,
 * which is the one thing worth saying about jobs in general rather than about
 * any one of them.
 */
export function JobsView() {
  const { stats, enabled, error } = useJobs()
  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center'>
      {error ? (
        <div className='rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger'>
          Can&apos;t reach the worker server: {error}. Start it with{' '}
          <code className='font-mono'>pnpm server</code>.
        </div>
      ) : null}
      {!enabled ? (
        <>
          <CalendarClock className='size-8 text-fg-4' />
          <p className='text-body-sm text-fg-3'>The server has no job queue configured.</p>
          <p className='max-w-md text-label text-fg-4'>
            Pass <code className='font-mono'>queue: {'{ maxConcurrency, … }'}</code> to{' '}
            <code className='font-mono'>createWorkerServer</code> — the dev server enables it by
            default.
          </p>
        </>
      ) : (
        <>
          <Empty
            icon={<ListChecks />}
            title='No job selected'
            description={
              <>
                Pick one on the left, or schedule one with <EmptyKey>+</EmptyKey> above.
              </>
            }
          />
          {stats ? (
            <div className='mt-2 w-full max-w-xl'>
              <QueueStatsStrip stats={stats} />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

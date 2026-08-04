# @workerdeck/queue

Job queue over the WorkerDeck session runner: remote services schedule one-shot runs; the queue
executes them as ordinary sessions with bounded concurrency and token budgets, delivering progress
and completion via webhooks. Pluggable adapter interface — in-memory bundled; redis/bullmq/pubsub
adapters can implement the same contract.

Part of [WorkerDeck](https://github.com/tobiasstrebitzer/workerdeck). It runs jobs through
[`@workerdeck/core`](https://www.npmjs.com/package/@workerdeck/core)'s `SessionRunner` and is
usually consumed indirectly: pass the `queue` option to
[`@workerdeck/server`](https://www.npmjs.com/package/@workerdeck/server) and it mounts
`/jobs` + `/queue` REST routes plus a `/queue/ws` live stream, with
[`@workerdeck/client`](https://www.npmjs.com/package/@workerdeck/client) as the caller.
Use this package directly to embed the queue in a custom host or to write a shared-backend adapter.

## Install

```bash
npm install @workerdeck/queue
```

## Usage

A job is **one unattended run**: the session executes `session.prompt`, the first turn result
completes the job (result, cumulative usage, cost), and the session is closed.

```ts
import { JobQueue } from '@workerdeck/queue'
import { SessionRunner } from '@workerdeck/core'

const queue = new JobQueue({
  // Typically the server registry's create(), so job sessions are ordinary
  // sessions clients can attach to and watch.
  createRunner: (config) => new SessionRunner(config),
  maxConcurrency: 2,
  sessionTokenLimit: 200_000,          // per-job cap (input+output+cache); exceeding kills the run
  dailyTokenLimit: 2_000_000,          // global UTC-day budget; queued jobs held once exhausted
  maxJobDurationMs: 1_800_000,         // wall-clock watchdog for stuck CLIs
  retention: { maxAgeMs: 86_400_000 }, // expire terminal jobs
})

const job = await queue.submit({
  session: { cwd: '/srv/checkout', prompt: '/verify-content 42' },
  webhook: { url: 'https://my-app.test/hooks/claude', headers: { authorization: '…' } },
  attempts: 3, // failed (not canceled) runs re-queue with exponential backoff
})
// job_submitted → job_started → job_progress → job_retrying? → job_completed
// arrive at the webhook (ordered per job, delivery retried with backoff).

await queue.get(job.id)   // JobInfo | null
await queue.stats()       // { running, queued, dailyTokensUsed, paused, … }
await queue.cancel(job.id)
queue.close()             // stop scheduling; job state stays in the adapter
```

### The `QueueAdapter` contract

Job state lives behind the `QueueAdapter` interface: `add`, `claimNext`, `get`, `list`, `update`,
`prune`, `addDailyTokens`/`dailyTokens`, and an optional `onWork` wakeup for shared backends.
Two rules matter when implementing one:

- `claimNext()` must be **atomic** across workers — two concurrent claims must never return the
  same job — and must skip queued jobs whose `nextRunAt` is still in the future (retry backoff).
- Daily token counters live in the adapter (keyed by UTC `YYYY-MM-DD`), so budgets hold across
  multiple workers sharing a backend.

The bundled `InMemoryQueueAdapter` is single-process and non-persistent: jobs and daily counters
reset on restart. Back the queue with a shared store for anything beyond one trusted host.

### Runs that park

A job whose session is waiting on a deferred execution does not sit and hold a slot. The session
parks — its state is snapshotted, its runner torn down — and the job goes `parked`, emitting
`job_parked` with the `executionId` it waits on. It keeps its attempt, its accumulated usage, and
its place, but frees its concurrency slot and stops its wall-clock clock; `job_resumed` fires when
the result lands. One worker can therefore have a hundred runs waiting on the world and still run
only three at a time.

`parked` is not terminal anywhere: `claimNext` never claims one, retention never prunes one, and
cancelling one discards its snapshot so nothing can wake it. `maxParkedDurationMs` caps total
parked time across all parks of a run, and `QueueStats.parked` / `JobInfo.parkedAt` /
`JobInfo.parkedExecutionId` report what is waiting on what. A park that may outlive the process
needs a durable session store on the server side.

## Options at a glance

| Option | Default | Effect |
| --- | --- | --- |
| `maxConcurrency` | 1 | Concurrent job sessions. |
| `sessionTokenLimit` | off | Token cap per job run; exceeding interrupts and fails the job. |
| `dailyTokenLimit` | off | Global budget per UTC day; queued jobs held until rollover. |
| `maxJobDurationMs` | off | Wall-clock cap per run — the watchdog for stuck CLIs. |
| `killGraceMs` | 5000 | Wind-down after a kill before the run is force-finalized. |
| `retention` | keep forever | Prune terminal jobs older than `maxAgeMs` (periodic sweep). |
| `webhookAttempts` / `webhookRetryDelayMs` | 3 / 500ms | Delivery retries per event, exponential backoff. |
| `buildRunnerConfig` | identity | Patch job session configs (env, tool policy) before they run. |
| `onEvent` | — | Local observer for every `JobEvent`, in addition to any webhook. |

Per-request, `CreateJobRequest` adds `attempts`, `retryDelayMs`, `maxTokens`, `maxDurationMs`
(the stricter of request and queue limits wins), `webhook.progress: 'completion'` to quiet
progress deliveries, and free-form `meta`.

## License

MIT © Tobias Strebitzer — see
[LICENSE](https://github.com/tobiasstrebitzer/workerdeck/blob/master/LICENSE).

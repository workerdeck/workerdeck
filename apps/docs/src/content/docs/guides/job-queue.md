---
title: Job queue
description: One-shot unattended runs with bounded concurrency, token budgets, retries, webhooks, and a live queue stream.
order: 3
---

The job queue lets remote services schedule unattended runs. A job is **one-shot**: the session
executes the prompt, the first run result completes the job (`result`, cumulative `usage`,
cost), and the session is closed. Job sessions are ordinary registry sessions, so the web
dashboard (or any client) can attach and watch them stream in real time.

## Enabling the queue

Pass `queue` options to `createWorkerServer` to mount `/jobs` + `/queue` routes plus the
`/queue/ws` stream:

```ts
const worker = createWorkerServer({
  authenticate,
  queue: {
    maxConcurrency: 2,          // concurrent job sessions
    sessionTokenLimit: 200_000, // tokens per job (input+output+cache); exceeding kills the run
    dailyTokenLimit: 2_000_000, // global budget per UTC day; queued jobs held once exhausted
    maxJobDurationMs: 1_800_000,          // wall-clock watchdog: kills runs a stuck CLI would wedge
    retention: { maxAgeMs: 86_400_000 },  // expire terminal jobs (in-memory grows unboundedly otherwise)
    // adapter: myRedisAdapter, // defaults to the bundled in-memory adapter
  },
})
```

All queue options are documented in the [server reference](/workerdeck/docs/reference/server/).

## Scheduling jobs

Via the client SDK, or plain REST (`POST/GET/DELETE /v1/jobs`, `GET /v1/queue`):

```ts
const job = await client.createJob({
  session: { cwd: '/srv/checkout', prompt: '/verify-content 42' },
  webhook: { url: 'https://my-app.test/hooks/claude', headers: { authorization: '…' } },
  attempts: 3, // failed (not canceled) runs re-queue with exponential backoff
})
await client.getJob(job.id) // plus listJobs(), cancelJob(id), queueStats()
```

Per request, `CreateJobRequest` adds `attempts`, `retryDelayMs`, `maxTokens`, `maxDurationMs`
(the stricter of request and queue limits wins), `webhook.progress: 'completion'` to quiet
progress deliveries, and free-form `meta`. `session.prompt` is required;
`resume`/`forkSession` are not supported for queued jobs.

## Webhook event sequence

Deliveries are ordered per job, POSTed as JSON `JobEvent` bodies, and retried with exponential
backoff (default 3 attempts, 500 ms base delay):

```text
job_started → job_progress (per assistant message / permission request)
            → job_parked / job_resumed (waiting on a deferred execution)
            → job_retrying (on a failed attempt with attempts left)
            → job_completed (always terminal)
```

`job_submitted` goes to local observers and the queue WS only — the submitter already has the
POST response. `job_progress` carries a `JobProgress` with a preview and, for
`permission_requested`, the full request (including `AskUserQuestion` input) so webhook
consumers can answer via `POST /v1/sessions/:sessionId/permissions/:requestId` — see
[Permissions](/workerdeck/docs/guides/permissions/) and `questionBehavior` for the
unattended-run policies.

## Budgets, watchdog, retries, retention

- **Per-session token limit** (`sessionTokenLimit` / per-job `maxTokens`) — counts input +
  output + cache-creation + cache-read tokens; exceeding interrupts and fails the run.
- **Daily token limit** (`dailyTokenLimit`) — a global budget per UTC day; once exhausted,
  queued jobs are held (`paused: true` in stats) until rollover.
- **Watchdog** (`maxJobDurationMs` / per-job `maxDurationMs`) — a wall-clock cap against stuck
  CLIs, with a `killGraceMs` wind-down (default 5000 ms) before the run is force-finalized.
- **Retries** — `attempts` on the request: failed (not canceled) runs re-queue until that many
  attempts have been made, delayed by `retryDelayMs` (default 5000 ms), doubled each retry.
  `JobInfo.nextRunAt` says when the next attempt may start.
- **Parked cap** (`maxParkedDurationMs`) — the bound on waiting rather than running. Time spent
  parked on a deferred execution is excluded from the duration watchdog: a run waiting on a
  remote worker is not a stuck CLI.
- **Retention** (`retention.maxAgeMs`) — a periodic sweep prunes terminal jobs; without it the
  in-memory adapter grows unboundedly.

## The live queue stream

Instead of polling, stream the whole queue over `WS /v1/queue/ws`:

```ts
const queueHandle = client.attachQueue()
queueHandle.on('event', (e) => console.log(e.type, e.job.id))
queueHandle.on('stats', (stats) => console.log(stats.running, 'running'))
```

The stream is one-way (server to client): every job's lifecycle as it happens, plus refreshed
stats after lifecycle changes. It has **no replay** — on (re)connect, re-list jobs and treat the
stream as updates. Job mutations stay on REST.

## The QueueAdapter contract

Job state lives behind the `QueueAdapter` interface: `add`, `claimNext`, `get`, `list`,
`update`, `prune`, `addDailyTokens`/`dailyTokens`, and an optional `onWork` wakeup for shared
backends. Two rules matter when implementing one:

- `claimNext()` must be **atomic** across workers — two concurrent claims must never return the
  same job — and must skip queued jobs whose `nextRunAt` is still in the future (retry backoff).
- Daily token counters live in the adapter (keyed by UTC `YYYY-MM-DD`), so budgets hold across
  multiple workers sharing a backend.

The bundled `InMemoryQueueAdapter` is **single-process and non-persistent**: jobs and daily
counters reset on restart. Back the queue with a shared store for anything beyond one trusted
host. Note that `JobQueue` currently assumes the claiming process runs the job — multi-worker
deployments need a claim-lease/heartbeat, and webhook ordering is per-process.

## Deferred execution

A job whose run calls a tool nothing here can answer — a remote worker, a batch window, a human —
does not sit and hold a slot. The session **parks**: its state is snapshotted, its runner is torn
down, and the job goes `parked` (`job_parked`, with the `executionId` it waits on). It keeps no
concurrency slot and burns no wall-clock budget, so the next queued job starts immediately.

Whoever does the work calls back when it's done:

```bash
curl -X POST $SERVER/v1/executions/$EXECUTION_ID/result \
  -H 'content-type: application/json' \
  -d '{"status":"ok","output":{"type":"json","value":{"rows":128}}}'
```

The session is rebuilt under its own id — same transcript, same `seq` numbering, mid-turn — the
result goes into the agent loop, and the job returns to `running` (`job_resumed`) until its turn
result completes it. `QueueStats.parked` counts the waiting runs; `JobInfo.parkedAt` /
`parkedExecutionId` say what each one is waiting for.

`parked` is not terminal anywhere: `claimNext` never claims one, retention never prunes one, and
cancelling a parked job discards its snapshot so nothing can wake it. A `failed` result — or the
execution watchdog's timeout — reaches the agent as ordinary tool output, which it adapts to,
rather than failing the run. Wiring the executor side is in
[the server reference](/workerdeck/docs/reference/server/).

A park that may outlive the process needs a durable store —
`parking: { store: createFileSessionStore({ dir }) }`, plus the restart guard, in
[Deployment](/workerdeck/docs/guides/deployment/#restarts-parked-sessions-and-the-deploy-guard).

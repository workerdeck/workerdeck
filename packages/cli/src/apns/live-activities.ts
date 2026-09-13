import type { PermissionRequest, SessionEventBody, SessionInfo } from '@workerdeck/protocol'
import {
  attributesFor,
  contentHash,
  projectContentState,
  type ActivityAttributes,
  type ActivityContentState,
  type ActivityPhaseName,
} from './live-activity.ts'

// Swallows the transient `running` a session flashes at `system_init` before dropping back to idle.
// Without it, creating a session without a prompt raises a card and ends it two seconds later.
const START_DEBOUNCE_MS = 2_000
// A quick follow-up prompt keeps the card and its update token, which is worth more than ending
// promptly: a start costs a token round-trip through the phone.
const END_GRACE_MS = 20_000
const FLUSH_DEBOUNCE_MS = 5_000
const MIN_UPDATE_INTERVAL_MS = 30_000
const HEARTBEAT_MS = 10 * 60 * 1000
// The system stops accepting updates at 8 h. Renewing before that is cheaper than explaining a
// card that silently stopped moving.
const RENEW_MS = 7 * 60 * 60 * 1000 + 45 * 60 * 1000

const ENGAGED = new Set<SessionInfo['status']>(['running', 'awaiting_approval'])

const RELEVANT = new Set<SessionEventBody['type']>([
  'status_changed',
  'permission_requested',
  'permission_resolved',
  'checklist',
  'turn_result',
  'session_error',
  'session_closed',
])

// The slice of `Runner` this needs, spelled out so the tests can drive a fake one and the CLI never
// depends on more of core than it reads.
export type ActivityRunner = {
  readonly id: string
  info(): SessionInfo
  readonly pendingApprovals: PermissionRequest[]
  subscribe(listener: (event: { type: string }) => void, afterSeq?: number): () => void
}

export type ActivitySource = {
  observe(listener: (runner: ActivityRunner) => void): () => void
}

// What the forwarder does with a decision. Fan-out across devices, the registry and APNs all live
// on the other side of this seam; the driver only decides *when* and *what*.
export type ActivityTarget = {
  start(attributes: ActivityAttributes, state: ActivityContentState): void
  update(sessionId: string, state: ActivityContentState, options: { urgent: boolean }): void
  end(sessionId: string, state: ActivityContentState): void
}

type Tracked = {
  attributes: ActivityAttributes
  startedAtMs: number
  // A card the gateway has committed to. Updates before this are folded into `pending` instead.
  started: boolean
  pending?: ActivityContentState
  lastHash?: string
  lastSentAt: number
  lastRequestId?: string
  lastWaiting: boolean
  timers: Map<TimerName, ReturnType<typeof setTimeout>>
}

type TimerName = 'start' | 'end' | 'flush' | 'heartbeat' | 'renew'

function finalPhaseFor(status: SessionInfo['status']): ActivityPhaseName {
  switch (status) {
    case 'parked': {
      return 'parked'
    }
    case 'failed': {
      return 'failed'
    }
    case 'closed': {
      return 'ended'
    }
    default: {
      return 'done'
    }
  }
}

function isWaiting(phase: ActivityPhaseName): boolean {
  return phase === 'approval' || phase === 'question' || phase === 'plan'
}

export function driveLiveActivities(options: {
  source: ActivitySource
  target: ActivityTarget
  hostIdOf?: () => string | undefined
}): () => void {
  const sessions = new Map<string, Tracked>()
  const unsubscribes = new Set<() => void>()

  const clear = (tracked: Tracked, name: TimerName): void => {
    const handle = tracked.timers.get(name)
    if (handle !== undefined) {
      clearTimeout(handle)
      tracked.timers.delete(name)
    }
  }

  const arm = (tracked: Tracked, name: TimerName, delay: number, run: () => void): void => {
    clear(tracked, name)
    tracked.timers.set(
      name,
      setTimeout(() => {
        tracked.timers.delete(name)
        run()
      }, delay),
    )
  }

  const forget = (sessionId: string): void => {
    const tracked = sessions.get(sessionId)
    if (tracked === undefined) {
      return
    }
    for (const name of tracked.timers.keys()) {
      clear(tracked, name)
    }
    sessions.delete(sessionId)
  }

  const send = (runner: ActivityRunner, tracked: Tracked, state: ActivityContentState, urgent: boolean): void => {
    const hash = contentHash(state)
    if (hash === tracked.lastHash) {
      return
    }
    tracked.lastHash = hash
    tracked.lastSentAt = Date.now()
    tracked.pending = undefined
    clear(tracked, 'flush')
    tracked.attributes = attributesFor(runner.info(), options.hostIdOf?.())
    if (!tracked.started) {
      tracked.started = true
      options.target.start(tracked.attributes, state)
    } else {
      options.target.update(runner.id, state, { urgent })
    }
    arm(tracked, 'heartbeat', HEARTBEAT_MS, () => {
      const current = sessions.get(runner.id)
      if (current !== undefined && current.started) {
        // Refreshes `stale-date` only. Without it a live card dims after 20 minutes of a turn that
        // is genuinely just thinking.
        options.target.update(runner.id, { ...state, seq: runner.info().lastSeq }, { urgent: false })
        current.lastSentAt = Date.now()
      }
    })
  }

  const finish = (runner: ActivityRunner, tracked: Tracked, phase: ActivityPhaseName): void => {
    if (tracked.started) {
      options.target.end(runner.id, projectContentState({ info: runner.info(), startedAtMs: tracked.startedAtMs, finalPhase: phase }))
    }
    forget(runner.id)
  }

  const evaluate = (runner: ActivityRunner, immediate = false): void => {
    const info = runner.info()
    const request = runner.pendingApprovals[0]
    const now = Date.now()

    if (!ENGAGED.has(info.status)) {
      const tracked = sessions.get(info.id)
      if (tracked === undefined) {
        return
      }
      clear(tracked, 'start')
      if (info.status === 'idle') {
        arm(tracked, 'end', END_GRACE_MS, () => finish(runner, tracked, 'done'))
        return
      }
      finish(runner, tracked, finalPhaseFor(info.status))
      return
    }

    let tracked = sessions.get(info.id)
    if (tracked === undefined) {
      tracked = {
        attributes: attributesFor(info, options.hostIdOf?.()),
        startedAtMs: now,
        started: false,
        lastSentAt: 0,
        lastWaiting: false,
        timers: new Map(),
      }
      sessions.set(info.id, tracked)
    }
    const current = tracked
    clear(current, 'end')

    const state = projectContentState({ info, request, startedAtMs: current.startedAtMs })
    const waiting = isWaiting(state.phase)
    // A new request, or the card crossing between working and waiting, is what a person is waiting
    // to see. Everything else — a checklist tick, a tool title — can ride a coalesced push.
    const urgent = waiting !== current.lastWaiting || state.request?.id !== current.lastRequestId
    current.lastWaiting = waiting
    current.lastRequestId = state.request?.id

    if (!current.started && current.timers.get('start') === undefined) {
      current.pending = state
      if (waiting || immediate) {
        // The whole point of the card. Debouncing an approval would mean the phone learns about it
        // two seconds after the desktop does. A renewal skips the debounce too: the flash it exists
        // to swallow cannot happen to a session that has been running for eight hours.
        send(runner, current, state, true)
        arm(current, 'renew', RENEW_MS, () => renew(runner))
      } else {
        arm(current, 'start', START_DEBOUNCE_MS, () => {
          const pending = sessions.get(runner.id)
          if (pending === undefined || !ENGAGED.has(runner.info().status)) {
            return
          }
          send(runner, pending, pending.pending ?? state, true)
          arm(pending, 'renew', RENEW_MS, () => renew(runner))
        })
      }
      return
    }

    if (!current.started) {
      current.pending = state
      return
    }

    if (urgent) {
      send(runner, current, state, true)
      return
    }

    current.pending = state
    const since = now - current.lastSentAt
    const delay = Math.max(FLUSH_DEBOUNCE_MS, MIN_UPDATE_INTERVAL_MS - since)
    arm(current, 'flush', delay, () => {
      const pending = sessions.get(runner.id)
      if (pending?.pending !== undefined) {
        send(runner, pending, pending.pending, false)
      }
    })
  }

  // End and start again rather than let the system's 8 h ceiling stop the card mid-turn. The card
  // blinks once; the alternative is one that quietly stops telling the truth.
  const renew = (runner: ActivityRunner): void => {
    const tracked = sessions.get(runner.id)
    if (tracked === undefined || !ENGAGED.has(runner.info().status)) {
      return
    }
    finish(runner, tracked, 'ended')
    evaluate(runner, true)
  }

  const stop = options.source.observe((runner) => {
    const unsubscribe = runner.subscribe((event) => {
      if (!RELEVANT.has(event.type as SessionEventBody['type'])) {
        return
      }
      evaluate(runner)
      if (event.type === 'session_closed') {
        unsubscribe()
        unsubscribes.delete(unsubscribe)
      }
    }, runner.info().lastSeq)
    unsubscribes.add(unsubscribe)
    evaluate(runner)
  })

  return () => {
    stop()
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
    unsubscribes.clear()
    for (const sessionId of sessions.keys()) {
      forget(sessionId)
    }
  }
}

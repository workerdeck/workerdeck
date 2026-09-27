import { DemoGateway, type CommandEvent } from '../stage/gateway.ts'
import { beat, say, status, turnEnd, user, event } from '../stage/tape.ts'
import { Director, type DirectorHost } from './director.ts'
import type { Card, Hint, Journey, Region, Scene, TourState, ViewState } from './types.ts'

type Listener = () => void

type Run = { abort: AbortController; advance: (() => void) | undefined; reached: number }

export type ControllerOptions = { home: () => Scene; speed?: number }

const FREE_TEXT_REPLY =
  "This workspace is a scripted demo, so there's no model behind it. Look for the periwinkle prompts: click one and I'll act it out."

export class TourController {
  readonly #listeners = new Set<Listener>()
  readonly #home: () => Scene
  readonly #speed: number
  readonly #totals = new Map<string, number>()
  #gateway: DemoGateway
  #view: ViewState
  #state: TourState
  #run: Run | undefined

  constructor(options: ControllerOptions) {
    this.#home = options.home
    this.#speed = options.speed ?? 1
    const scene = this.#home()
    this.#gateway = this.#stage(scene)
    this.#view = viewOf(scene, this.#gateway)
    this.#state = idle(0)
  }

  get gateway(): DemoGateway {
    return this.#gateway
  }

  get state(): TourState {
    return this.#state
  }

  get view(): ViewState {
    return this.#view
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  start(journey: Journey, at = 0): void {
    this.#stop()
    const scene = journey.scene()
    const gateway = this.#stage(scene)
    this.#gateway = gateway
    this.#view = viewOf(scene, gateway)
    this.#state = {
      ...idle(this.#state.epoch + 1),
      journey,
      total: this.#totals.get(journey.id),
    }
    const run: Run = { abort: new AbortController(), advance: undefined, reached: 0 }
    this.#run = run
    this.#emit()
    void this.#count(journey)
    const director = new Director(this.#host(run, gateway, at))
    journey.run(director).then(
      () => this.#finish(run),
      (error: unknown) => {
        if (!run.abort.signal.aborted) {
          console.error('demo journey failed', error)
          this.#finish(run)
        }
      },
    )
  }

  next(): void {
    const advance = this.#run?.advance
    if (advance) {
      this.#run!.advance = undefined
      advance()
    }
  }

  back(): void {
    const journey = this.#state.journey
    if (journey) {
      this.start(journey, Math.max(0, this.#state.checkpoint - 1))
    }
  }

  restart(): void {
    const journey = this.#state.journey
    if (journey) {
      this.start(journey, 0)
    }
  }

  exit(): void {
    this.#stop()
    const scene = this.#home()
    this.#gateway = this.#stage(scene)
    this.#view = viewOf(scene, this.#gateway)
    this.#state = idle(this.#state.epoch + 1)
    this.#emit()
  }

  select(sessionId: string): void {
    this.#gateway.markSeen(sessionId)
    this.#setView({ ...this.#view, selected: sessionId })
  }

  toggle(section: string): void {
    this.#setView({ ...this.#view, expanded: { ...this.#view.expanded, [section]: !this.#view.expanded[section] } })
  }

  #host(run: Run, gateway: DemoGateway, skipUntil: number): DirectorHost {
    return {
      gateway,
      signal: run.abort.signal,
      skipUntil,
      reached: () => run.reached,
      enter: () => {
        const index = run.reached
        run.reached += 1
        if (index >= skipUntil) {
          this.#patch({ checkpoint: index })
        }
        return index
      },
      show: (card, hint, focus) => this.#show(card, hint, focus),
      dismiss: () => this.#patch({ card: undefined, hint: undefined }),
      waitForAdvance: () =>
        new Promise<void>((resolve) => {
          run.advance = resolve
        }),
      select: (sessionId) => this.select(sessionId),
      expand: (section, open) => this.#setView({ ...this.#view, expanded: { ...this.#view.expanded, [section]: open } }),
    }
  }

  #show(card: Card | undefined, hint: Hint | undefined, focus: Region[]): void {
    this.#patch({ card, hint, focus })
  }

  #finish(run: Run): void {
    if (this.#run !== run) {
      return
    }
    run.advance = undefined
    this.#totals.set(this.#state.journey!.id, run.reached)
    this.#patch({ finished: true, card: undefined, hint: undefined, focus: [], total: run.reached })
  }

  async #count(journey: Journey): Promise<void> {
    if (this.#totals.has(journey.id)) {
      return
    }
    const scratch = new DemoGateway(journey.scene().seeds, { speed: Number.POSITIVE_INFINITY })
    const run: Run = { abort: new AbortController(), advance: undefined, reached: 0 }
    const host: DirectorHost = {
      gateway: scratch,
      signal: run.abort.signal,
      skipUntil: Number.POSITIVE_INFINITY,
      reached: () => run.reached,
      enter: () => run.reached++,
      show: () => {},
      dismiss: () => {},
      waitForAdvance: () => Promise.resolve(),
      select: () => {},
      expand: () => {},
    }
    try {
      await journey.run(new Director(host))
      this.#totals.set(journey.id, run.reached)
      if (this.#state.journey?.id === journey.id) {
        this.#patch({ total: run.reached })
      }
    } finally {
      scratch.dispose()
    }
  }

  #stage(scene: Scene): DemoGateway {
    this.#gateway?.dispose()
    const gateway = new DemoGateway(scene.seeds, { speed: this.#speed, ...(scene.profiles ? { profiles: scene.profiles } : {}) })
    gateway.onCommand((command) => respond(gateway, command))
    gateway.subscribe(() => {
      const selected = this.#gateway === gateway ? this.#view.selected : scene.selected
      if (selected) {
        gateway.markSeen(selected)
      }
    })
    return gateway
  }

  #stop(): void {
    const run = this.#run
    if (run) {
      this.#run = undefined
      run.abort.abort(new DOMException('journey stopped', 'AbortError'))
    }
  }

  #setView(view: ViewState): void {
    this.#view = view
    this.#emit()
  }

  #patch(patch: Partial<TourState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

function respond(gateway: DemoGateway, { sessionId, frame }: CommandEvent): boolean {
  switch (frame.type) {
    case 'user_message': {
      gateway.apply(sessionId, user(frame.text))
      void gateway.play(
        sessionId,
        beat(400, status('running'), 700, say(FREE_TEXT_REPLY, { stream: true }), turnEnd(unchanged(gateway, sessionId))),
      )
      return true
    }
    case 'permission_decision': {
      gateway.apply(
        sessionId,
        event({ type: 'permission_resolved', requestId: frame.requestId, behavior: frame.behavior, resolvedBy: 'client' }),
      )
      return true
    }
    case 'interrupt': {
      gateway.apply(sessionId, status('idle'))
      return true
    }
    case 'set_model': {
      gateway.apply(sessionId, event({ type: 'model_changed', model: frame.model }))
      return true
    }
    case 'set_permission_mode': {
      gateway.apply(sessionId, event({ type: 'permission_mode_changed', mode: frame.mode }))
      return true
    }
    default: {
      return false
    }
  }
}

function unchanged(gateway: DemoGateway, sessionId: string): { totalCostUsd: number; numTurns: number } {
  const info = gateway.session(sessionId)
  return { totalCostUsd: info.totalCostUsd ?? 0, numTurns: (info.numTurns ?? 0) + 1 }
}

function viewOf(scene: Scene, gateway: DemoGateway): ViewState {
  const selected = scene.selected ?? gateway.sessionIds()[0]
  if (selected) {
    gateway.markSeen(selected)
  }
  return { selected, expanded: { sessions: true, ...scene.expanded } }
}

function idle(epoch: number): TourState {
  return { journey: undefined, epoch, checkpoint: 0, total: undefined, focus: [], card: undefined, hint: undefined, finished: false }
}

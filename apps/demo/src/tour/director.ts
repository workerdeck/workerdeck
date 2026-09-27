import type { CommandEvent, DemoGateway } from '../stage/gateway.ts'
import { user, type Beat } from '../stage/tape.ts'
import type { Card, Hint, Placement, Region } from './types.ts'

export type CardInput = {
  title: string
  body: string
  focus?: Region | Region[]
  placement?: Placement
  next?: string
}

export type DirectorHost = {
  gateway: DemoGateway
  signal: AbortSignal
  skipUntil: number
  reached: () => number
  enter: () => number
  show: (card: Card | undefined, hint: Hint | undefined, focus: Region[]) => void
  dismiss: () => void
  waitForAdvance: () => Promise<void>
  select: (sessionId: string) => void
  expand: (section: string, open: boolean) => void
}

export class Director {
  readonly #host: DirectorHost

  constructor(host: DirectorHost) {
    this.#host = host
  }

  get gateway(): DemoGateway {
    return this.#host.gateway
  }

  get fastForward(): boolean {
    return this.#host.reached() < this.#host.skipUntil
  }

  async explain(input: CardInput): Promise<void> {
    if (this.#enter()) {
      return
    }
    this.#host.show(card(input), undefined, regions(input.focus))
    await this.#guard(this.#host.waitForAdvance())
    this.#host.dismiss()
  }

  async hint(sessionId: string, prompt: string, input?: CardInput): Promise<void> {
    if (!this.#enter()) {
      const focus = input ? regions(input.focus) : ['agent-panel']
      this.#host.show(input ? card(input) : undefined, { sessionId, prompt }, focus)
      await this.#guard(this.#host.waitForAdvance())
      this.#host.show(undefined, undefined, [])
    }
    this.#host.gateway.apply(sessionId, user(prompt))
  }

  async until(match: (command: CommandEvent) => boolean, input: CardInput & { waiting: string }): Promise<CommandEvent | undefined> {
    if (this.#enter()) {
      return undefined
    }
    this.#host.show({ ...card(input), waiting: input.waiting }, undefined, regions(input.focus))
    const command = await this.#guard(this.#host.gateway.waitForCommand(match, this.#host.signal))
    this.#host.show(undefined, undefined, [])
    return command
  }

  async play(sessionId: string, beat: Beat): Promise<void> {
    this.#check()
    if (this.fastForward) {
      for (const cue of beat) {
        this.#host.gateway.apply(sessionId, cue)
      }
      return
    }
    await this.#guard(this.#host.gateway.play(sessionId, beat, this.#host.signal))
  }

  async together(...runs: Promise<void>[]): Promise<void> {
    await Promise.all(runs)
  }

  async sleep(ms: number): Promise<void> {
    this.#check()
    if (this.fastForward) {
      return
    }
    await this.#guard(new Promise<void>((resolve) => setTimeout(resolve, ms / this.#host.gateway.speed)))
  }

  focus(target: Region | Region[] | undefined): void {
    if (!this.fastForward) {
      this.#host.show(undefined, undefined, regions(target))
    }
  }

  select(sessionId: string): void {
    this.#check()
    this.#host.select(sessionId)
  }

  expand(section: string, open = true): void {
    this.#check()
    this.#host.expand(section, open)
  }

  #enter(): boolean {
    this.#check()
    return this.#host.enter() < this.#host.skipUntil
  }

  #check(): void {
    this.#host.signal.throwIfAborted()
  }

  async #guard<T>(work: Promise<T>): Promise<T> {
    const value = await work
    this.#check()
    return value
  }
}

function card(input: CardInput): Card {
  return {
    title: input.title,
    body: input.body,
    focus: regions(input.focus),
    placement: input.placement ?? 'auto',
    ...(input.next ? { next: input.next } : {}),
  }
}

function regions(focus: Region | Region[] | undefined): Region[] {
  if (focus === undefined) {
    return []
  }
  return Array.isArray(focus) ? focus : [focus]
}

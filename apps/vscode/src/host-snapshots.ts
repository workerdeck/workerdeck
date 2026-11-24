import type * as vscode from 'vscode'
import type { WorkerDeckClient } from '@workerdeck/client'
import { clientFor } from './gateway.ts'
import type { GatewayHost, HostStore } from './hosts.ts'

export const HOST_WAIT_MS = 4000

type Options<S> = {
  load: (host: GatewayHost, client: WorkerDeckClient | undefined) => Promise<S>
  // What a gateway reads as while it has never answered and the pass has stopped waiting for it.
  silent: S
  landed: () => void
  forget?: (hostId: string) => void
}

type Load = { pass: number; epoch: number; done: Promise<void> }

// One snapshot per gateway. Each draws as it answers (`landed`); one still silent after HOST_WAIT_MS lets the pass
// end. A pass needs a read that started after it did: a host still answering an older pass gets one follow-up queued
// behind it, never a second concurrent request. A refresh asked for during a pass queues one more pass. Any store
// change (a host's address or key) discards every landing started before it, so an old URL cannot answer for a new one.
export class HostSnapshots<S> implements vscode.Disposable {
  readonly #store: HostStore
  readonly #options: Options<S>
  readonly #snapshots = new Map<string, S>()
  readonly #current = new Map<string, Load>()
  readonly #follow = new Map<string, Promise<void>>()
  readonly #subscription: vscode.Disposable
  #pass = 0
  #epoch = 0
  #running: Promise<void> | undefined
  #queued: Promise<void> | undefined

  // Constructed before its owner subscribes to the store, so the epoch moves before the owner's refresh runs.
  constructor(store: HostStore, options: Options<S>) {
    this.#store = store
    this.#options = options
    this.#subscription = store.onDidChange(() => {
      this.#epoch += 1
      this.#current.clear()
      this.#follow.clear()
    })
  }

  get(hostId: string): S | undefined {
    return this.#snapshots.get(hostId)
  }

  values(): IterableIterator<S> {
    return this.#snapshots.values()
  }

  refresh(): Promise<void> {
    if (!this.#running) {
      this.#running = this.#run().finally(() => {
        this.#running = undefined
      })
      return this.#running
    }
    this.#queued ??= this.#running.then(noop, noop).then(() => {
      this.#queued = undefined
      return this.refresh()
    })
    return this.#queued
  }

  async #run(): Promise<void> {
    const pass = ++this.#pass
    const hosts = this.#store.all()
    for (const id of this.#snapshots.keys()) {
      if (!hosts.some((h) => h.id === id)) {
        this.#snapshots.delete(id)
        this.#options.forget?.(id)
      }
    }
    await Promise.all(hosts.map((host) => this.#await(host.id, pass)))
  }

  async #await(id: string, pass: number): Promise<void> {
    const current = this.#current.get(id)
    const done = !current ? this.#start(id) : current.pass >= pass ? current.done : this.#followUp(id, current.done)
    let timer: NodeJS.Timeout | undefined
    const waited = new Promise<'waited'>((resolve) => {
      timer = setTimeout(() => resolve('waited'), HOST_WAIT_MS)
    })
    const outcome = await Promise.race([done, waited])
    clearTimeout(timer)
    if (outcome === 'waited' && !this.#snapshots.has(id) && this.#store.get(id)) {
      this.#snapshots.set(id, this.#options.silent)
    }
  }

  #followUp(id: string, after: Promise<void>): Promise<void> {
    const held = this.#follow.get(id)
    if (held) {
      return held
    }
    const next: Promise<void> = after.then(() => {
      if (this.#follow.get(id) !== next) {
        return
      }
      this.#follow.delete(id)
      return this.#start(id)
    })
    this.#follow.set(id, next)
    return next
  }

  #start(id: string): Promise<void> {
    const host = this.#store.get(id)
    if (!host) {
      return Promise.resolve()
    }
    const epoch = this.#epoch
    const load: Load = { pass: this.#pass, epoch, done: Promise.resolve() }
    load.done = clientFor(this.#store, host)
      .then((client) => this.#options.load(host, client))
      .then((snap) => {
        if (this.#epoch === epoch && this.#store.get(id)) {
          this.#snapshots.set(id, snap)
          this.#options.landed()
        }
      }, noop)
      .finally(() => {
        if (this.#current.get(id) === load) {
          this.#current.delete(id)
        }
      })
    this.#current.set(id, load)
    return load.done
  }

  dispose(): void {
    this.#subscription.dispose()
  }
}

function noop(): void {}

import { isOwnerName, type ProfileInfo } from '@workerdeck/protocol'

export type OwnerServiceOptions = {
  owner?: string
  profiles: () => readonly ProfileInfo[]
  // The owners the relay enrolled this gateway with, once it said so.
  relayOwners?: () => readonly string[]
}

// Resolves whom a new session or agent answers to. Every answer is stamped where it lands, never resolved again.
// Whether the gateway holds several owners counts what config names now, every owner a record here still carries and
// every owner the relay ever enrolled it with, so a profile edit or a reconnect never makes it look single.
export class OwnerService {
  #owner: string | undefined
  #profiles: () => readonly ProfileInfo[]
  #relayOwners: () => readonly string[]
  #retained = new Set<string>()
  #enrolled = new Set<string>()

  constructor(options: OwnerServiceOptions) {
    if (options.owner !== undefined && !isOwnerName(options.owner)) {
      throw new Error('createWorkerServer: `owner` must be 1 to 32 lowercase letters, digits or dashes')
    }
    this.#owner = options.owner
    this.#profiles = options.profiles
    this.#relayOwners = options.relayOwners ?? (() => [])
  }

  local(): Set<string> {
    const owners = new Set<string>()
    if (this.#owner !== undefined) {
      owners.add(this.#owner)
    }
    for (const profile of this.#profiles()) {
      if (profile.owner !== undefined) {
        owners.add(profile.owner)
      }
    }
    return owners
  }

  retain(owner: string | undefined): void {
    if (owner !== undefined) {
      this.#retained.add(owner)
    }
  }

  multi(): boolean {
    const owners = this.local()
    for (const owner of [...this.#retained, ...this.#enrolledNow(), ...this.#enrolled]) {
      owners.add(owner)
    }
    return owners.size > 1
  }

  // Without any owner configured here, a relay that enrolled this gateway with exactly one owner names it.
  defaultOwner(): string | undefined {
    if (this.#owner !== undefined) {
      return this.#owner
    }
    const relay = this.#enrolledNow()
    return this.local().size === 0 && relay.length === 1 ? relay[0] : undefined
  }

  known(owner: string): boolean {
    return this.local().has(owner) || this.#enrolledNow().includes(owner)
  }

  forProfile(name: string | undefined): string | undefined {
    const profile = name === undefined ? undefined : this.#profiles().find((candidate) => candidate.name === name)
    const owner = profile?.owner ?? this.defaultOwner()
    this.retain(owner)
    return owner
  }

  #enrolledNow(): readonly string[] {
    const relay = this.#relayOwners()
    for (const owner of relay) {
      this.#enrolled.add(owner)
    }
    return relay
  }

  // An explicit owner must be one this gateway knows; on a gateway of several owners, none at all is refused.
  resolve(profile: string | undefined, explicit?: unknown): { owner: string | undefined } | { status: number; error: string } {
    if (explicit !== undefined) {
      if (!isOwnerName(explicit)) {
        return { status: 400, error: 'owner must be 1 to 32 lowercase letters, digits or dashes' }
      }
      if (!this.known(explicit)) {
        return { status: 409, error: `this gateway does not know the owner ${explicit}` }
      }
      this.retain(explicit)
      return { owner: explicit }
    }
    const owner = this.forProfile(profile)
    if (owner === undefined && this.multi()) {
      return { status: 409, error: `profile '${profile ?? 'default'}' names no owner and this gateway has no default owner` }
    }
    return { owner }
  }
}

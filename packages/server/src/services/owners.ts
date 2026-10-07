import { isOwnerName, type ProfileInfo } from '@workerdeck/protocol'

export type OwnerServiceOptions = {
  owner?: string
  profiles: () => readonly ProfileInfo[]
  // The owners the relay enrolled this gateway with, once it said so.
  relayOwners?: () => readonly string[]
}

// Resolves whom a new session or agent answers to. Every answer is stamped where it lands, never resolved again.
export class OwnerService {
  #owner: string | undefined
  #profiles: () => readonly ProfileInfo[]
  #relayOwners: () => readonly string[]

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

  multi(): boolean {
    return this.local().size > 1
  }

  // Without any owner configured here, a relay that enrolled this gateway with exactly one owner names it.
  defaultOwner(): string | undefined {
    if (this.#owner !== undefined) {
      return this.#owner
    }
    const relay = this.#relayOwners()
    return this.local().size === 0 && relay.length === 1 ? relay[0] : undefined
  }

  known(owner: string): boolean {
    return this.local().has(owner) || this.#relayOwners().includes(owner)
  }

  forProfile(name: string | undefined): string | undefined {
    const profile = name === undefined ? undefined : this.#profiles().find((candidate) => candidate.name === name)
    return profile?.owner ?? this.defaultOwner()
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
      return { owner: explicit }
    }
    const owner = this.forProfile(profile)
    if (owner === undefined && this.multi()) {
      return { status: 409, error: `profile '${profile ?? 'default'}' names no owner and this gateway has no default owner` }
    }
    return { owner }
  }
}

import { isOwnerName, type ProfileInfo } from '@workerdeck/protocol'

export type OwnerServiceOptions = {
  owner?: string
  profiles: () => readonly ProfileInfo[]
  // The owners the relay enrolled this gateway with, once it said so.
  relayOwners?: () => readonly string[]
  // The relay enrolled this gateway without an owner, so its one owner is a placeholder, never stamped.
  relayDefaulted?: () => boolean
}

// Two answers: `stampOwner`/`forProfile` (what a new record is stamped with, explicit owners only) and
// `defaultOwner`/`ownerFor` (read time, which may fall back to a relay-defaulted placeholder). Rules in GOTCHAS § owners.
export class OwnerService {
  #owner: string | undefined
  #profiles: () => readonly ProfileInfo[]
  #relayOwners: () => readonly string[]
  #relayDefaulted: () => boolean
  #retained = new Set<string>()
  #enrolled = new Set<string>()

  constructor(options: OwnerServiceOptions) {
    if (options.owner !== undefined && !isOwnerName(options.owner)) {
      throw new Error('createWorkerServer: `owner` must be 1 to 32 lowercase letters, digits or dashes')
    }
    this.#owner = options.owner
    this.#profiles = options.profiles
    this.#relayOwners = options.relayOwners ?? (() => [])
    this.#relayDefaulted = options.relayDefaulted ?? (() => false)
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

  // Replaces what records carry, after a rename moved every record off an owner.
  rebuildRetained(owners: Iterable<string | undefined>): void {
    this.#retained.clear()
    for (const owner of owners) {
      this.retain(owner)
    }
  }

  multi(): boolean {
    return this.#all().size > 1
  }

  // The configured default, else the one explicit owner this gateway has (config, records and enrollments together).
  stampOwner(): string | undefined {
    if (this.#owner !== undefined) {
      return this.#owner
    }
    const owners = this.#all()
    return owners.size === 1 ? [...owners][0] : undefined
  }

  defaultOwner(): string | undefined {
    return this.stampOwner() ?? (this.#all().size === 0 ? this.#placeholder() : undefined)
  }

  known(owner: string): boolean {
    return this.local().has(owner) || this.#enrolledNow().includes(owner)
  }

  forProfile(name: string | undefined): string | undefined {
    const owner = this.#profile(name)?.owner ?? this.stampOwner()
    this.retain(owner)
    return owner
  }

  ownerFor(name: string | undefined): string | undefined {
    return this.#profile(name)?.owner ?? this.defaultOwner()
  }

  #profile(name: string | undefined): ProfileInfo | undefined {
    return name === undefined ? undefined : this.#profiles().find((candidate) => candidate.name === name)
  }

  #all(): Set<string> {
    const owners = this.local()
    for (const owner of [...this.#retained, ...this.#enrolledNow(), ...this.#enrolled]) {
      owners.add(owner)
    }
    return owners
  }

  #placeholder(): string | undefined {
    return this.#relayDefaulted() ? this.#relayOwners()[0] : undefined
  }

  #enrolledNow(): readonly string[] {
    if (this.#relayDefaulted()) {
      return []
    }
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

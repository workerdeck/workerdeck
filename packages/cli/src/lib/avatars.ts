import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRecipe, decodePack, resolveRecipe, toAnimationStripPng, toPng, type Monkeypack, type Recipe } from '@monkeyart/composer'
import { defaultPackId, packIds, packUrl, type PackId } from '@monkeyart/packs'
import { projectAccent, type ProfileEngine } from '@workerdeck/protocol'
import type { AvatarImage, AvatarProvider } from '@workerdeck/server'

const EMBLEMS: Record<ProfileEngine, string> = { claude: 'claude', codex: 'codex', provider: 'rings' }

export const DEFAULT_AVATAR_PACKS: readonly PackId[] = ['monkey', 'steampunk-bulldogs', 'toad']

// What the agent store keeps: the pack beside the composer's recipe. A bare recipe predates packs and is a monkey.
type StoredRecipe = { pack: PackId; recipe: Recipe }

export function isPackId(id: string): id is PackId {
  return (packIds as readonly string[]).includes(id)
}

export class MonkeyartAvatars implements AvatarProvider {
  readonly #packs: readonly PackId[]
  #loaded = new Map<PackId, Promise<Monkeypack>>()
  #cache = new Map<string, AvatarImage>()

  constructor(packs: readonly PackId[] = DEFAULT_AVATAR_PACKS) {
    this.#packs = packs.length ? packs : [defaultPackId]
  }

  // A seed of the form `<pack>:<rest>` names its pack; any other seed picks one of the enabled packs by its hash, so a
  // grid of random candidates spreads across them.
  async roll(seed: string, engine: ProfileEngine | undefined, projectKey: string | undefined): Promise<StoredRecipe> {
    const id = this.#packFor(seed)
    const pack = await this.#load(id)
    const emblem = EMBLEMS[engine ?? 'claude']
    const recipe = createRecipe(pack, {
      seed,
      emblem: pack.emblems.some((e) => e.id === emblem) ? emblem : null,
      baseColor: projectAccent(projectKey ?? seed),
      backdrop: 'blend',
    })
    return { pack: id, recipe }
  }

  async still(recipe: unknown): Promise<AvatarImage> {
    return this.#render(recipe, 'still', async (pack, resolved) => ({ png: await toPng(pack, resolved) }))
  }

  async busy(recipe: unknown): Promise<AvatarImage | undefined> {
    const { pack } = this.#stored(recipe)
    if (!(await this.#load(pack)).animations.some((animation) => animation.id === 'busy')) {
      return undefined
    }
    return this.#render(recipe, 'busy', async (p, resolved) => {
      const strip = await toAnimationStripPng(p, resolved, 'busy')
      return { png: strip.png, durations: strip.durations }
    })
  }

  #packFor(seed: string): PackId {
    const prefix = seed.slice(0, seed.indexOf(':'))
    if (isPackId(prefix)) {
      return prefix
    }
    const digest = createHash('sha256').update(seed).digest()
    return this.#packs[digest.readUInt32BE(0) % this.#packs.length]!
  }

  #stored(recipe: unknown): StoredRecipe {
    const held = recipe as Partial<StoredRecipe> | null
    if (held && typeof held === 'object' && typeof held.pack === 'string' && isPackId(held.pack) && held.recipe) {
      return held as StoredRecipe
    }
    return { pack: defaultPackId, recipe: recipe as Recipe }
  }

  async #render(
    recipe: unknown,
    kind: string,
    draw: (pack: Monkeypack, resolved: Recipe) => Promise<{ png: Uint8Array; durations?: number[] }>,
  ): Promise<AvatarImage> {
    const stored = this.#stored(recipe)
    const pack = await this.#load(stored.pack)
    const key = `${kind}:${pack.checksum}:${JSON.stringify(stored.recipe)}`
    const held = this.#cache.get(key)
    if (held) {
      return held
    }
    const { recipe: resolved } = resolveRecipe(pack, stored.recipe)
    const drawn = await draw(pack, resolved)
    const image: AvatarImage = { ...drawn, etag: `"${createHash('sha256').update(key).digest('hex').slice(0, 32)}"` }
    this.#cache.set(key, image)
    return image
  }

  #load(id: PackId): Promise<Monkeypack> {
    let pack = this.#loaded.get(id)
    if (!pack) {
      pack = readFile(packUrl(id)).then((bytes) => decodePack(new Uint8Array(bytes)))
      this.#loaded.set(id, pack)
    }
    return pack
  }
}

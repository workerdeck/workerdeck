import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRecipe, decodePack, resolveRecipe, toAnimationStripPng, toPng, type Monkeypack, type Recipe } from '@monkeyart/composer'
import { defaultPackId, packUrl } from '@monkeyart/packs'
import { projectAccent, type ProfileEngine } from '@workerdeck/protocol'
import type { AvatarImage, AvatarProvider } from '@workerdeck/server'

const EMBLEMS: Record<ProfileEngine, string> = { claude: 'claude', codex: 'codex', provider: 'rings' }

export class MonkeyartAvatars implements AvatarProvider {
  #pack: Promise<Monkeypack> | undefined
  #cache = new Map<string, AvatarImage>()

  async roll(seed: string, engine: ProfileEngine | undefined, projectKey: string | undefined): Promise<Recipe> {
    const pack = await this.#loadPack()
    const emblem = EMBLEMS[engine ?? 'claude']
    return createRecipe(pack, {
      seed,
      emblem: pack.emblems.some((e) => e.id === emblem) ? emblem : null,
      baseColor: projectAccent(projectKey ?? seed),
      backdrop: 'blend',
    })
  }

  async still(recipe: unknown): Promise<AvatarImage> {
    return this.#render(recipe, 'still', async (pack, resolved) => ({ png: await toPng(pack, resolved) }))
  }

  async busy(recipe: unknown): Promise<AvatarImage | undefined> {
    const pack = await this.#loadPack()
    if (!pack.animations.some((animation) => animation.id === 'busy')) {
      return undefined
    }
    return this.#render(recipe, 'busy', async (p, resolved) => {
      const strip = await toAnimationStripPng(p, resolved, 'busy')
      return { png: strip.png, durations: strip.durations }
    })
  }

  async #render(
    recipe: unknown,
    kind: string,
    draw: (pack: Monkeypack, resolved: Recipe) => Promise<{ png: Uint8Array; durations?: number[] }>,
  ): Promise<AvatarImage> {
    const pack = await this.#loadPack()
    const key = `${kind}:${pack.checksum}:${JSON.stringify(recipe)}`
    const held = this.#cache.get(key)
    if (held) {
      return held
    }
    const { recipe: resolved } = resolveRecipe(pack, recipe as Recipe)
    const drawn = await draw(pack, resolved)
    const image: AvatarImage = { ...drawn, etag: `"${createHash('sha256').update(key).digest('hex').slice(0, 32)}"` }
    this.#cache.set(key, image)
    return image
  }

  #loadPack(): Promise<Monkeypack> {
    this.#pack ??= readFile(packUrl(defaultPackId)).then((bytes) => decodePack(new Uint8Array(bytes)))
    return this.#pack
  }
}

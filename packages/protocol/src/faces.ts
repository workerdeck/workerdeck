// An agent's face: a robot drawn from a few fixed slots, each a kind and a colour. Clients draw it; the gateway only
// stores, rolls and validates it. A colour is a swatch name with an optional tone (`teal`, `amber/base`); `project`
// stands for the session's project swatch, so a face follows its project's colour.

export const FACE_SWATCHES = ['blue', 'indigo', 'violet', 'rose', 'coral', 'copper', 'amber', 'olive', 'green', 'mint', 'teal', 'steel'] as const
export type FaceSwatch = (typeof FACE_SWATCHES)[number]

export const FACE_TONES = ['wash', 'base', 'deep', 'soft', 'glow', 'screen', 'ink'] as const
export type FaceTone = (typeof FACE_TONES)[number]

export const FACE_KINDS = {
  tile: ['soft', 'squircle', 'boxy'],
  antenna: ['none', 'ball', 'triangle', 'square', 'diamond', 'twin'],
  visor: ['none', 'band', 'inset'],
  eyes: ['bar', 'split', 'segments', 'slit'],
  mouth: ['none', 'grill', 'vent', 'speaker'],
} as const

export type FaceTileShape = (typeof FACE_KINDS.tile)[number]
export type FaceAntenna = (typeof FACE_KINDS.antenna)[number]
export type FaceVisor = (typeof FACE_KINDS.visor)[number]
export type FaceEyes = (typeof FACE_KINDS.eyes)[number]
export type FaceMouth = (typeof FACE_KINDS.mouth)[number]

export const FACE_PARTS = ['antenna', 'visor', 'eyes', 'mouth'] as const
export type FacePart = (typeof FACE_PARTS)[number]

type Layer<K extends string> = { kind: K; color?: string }

export type AgentFace = {
  v: 1
  backdrop?: { color?: string }
  tile?: { shape?: FaceTileShape; color?: string }
  antenna?: Layer<FaceAntenna>
  visor?: Layer<FaceVisor>
  eyes?: Layer<FaceEyes>
  mouth?: Layer<FaceMouth>
}

// A merge over a stored face: each key replaces that slot's fields it names.
export type AgentFacePatch = {
  backdrop?: { color?: string }
  tile?: { shape?: FaceTileShape; color?: string }
  antenna?: Partial<Layer<FaceAntenna>>
  visor?: Partial<Layer<FaceVisor>>
  eyes?: Partial<Layer<FaceEyes>>
  mouth?: Partial<Layer<FaceMouth>>
}

export const AGENT_FACE_MAX_BYTES = 1024

// `PROJECT_ACCENTS` one to one, so a project's accent and its avatars' colour agree.
export const PROJECT_SWATCHES: readonly FaceSwatch[] = ['blue', 'violet', 'green', 'copper', 'rose', 'teal', 'olive', 'indigo']

export function fnv1a(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)
  }
  return hash >>> 0
}

export function projectSwatch(key: string): FaceSwatch {
  return PROJECT_SWATCHES[fnv1a(key) % PROJECT_SWATCHES.length]!
}

export function isFaceSwatch(value: unknown): value is FaceSwatch {
  return (FACE_SWATCHES as readonly unknown[]).includes(value)
}

export function isFaceTone(value: unknown): value is FaceTone {
  return (FACE_TONES as readonly unknown[]).includes(value)
}

export function resolveFaceColor(ref: string | undefined, project: FaceSwatch, tone: FaceTone): { swatch: FaceSwatch; tone: FaceTone } {
  const [name, own] = (ref ?? 'project').split('/')
  const swatch = isFaceSwatch(name) ? name : project
  return { swatch, tone: isFaceTone(own) ? own : tone }
}

function colorError(ref: unknown, where: string): string | undefined {
  if (ref === undefined) {
    return undefined
  }
  if (typeof ref !== 'string') {
    return `${where}.color must be a string`
  }
  const [name, tone, extra] = ref.split('/')
  if (extra !== undefined || (name !== 'project' && !isFaceSwatch(name)) || (tone !== undefined && !isFaceTone(tone))) {
    return `${where}.color "${ref}" is not a swatch (${FACE_SWATCHES.join(', ')}, or project), optionally /tone (${FACE_TONES.join(', ')})`
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function slotError(value: unknown, where: string, kinds: readonly string[], key: 'kind' | 'shape'): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return `${where} must be an object`
  }
  const kind = value[key]
  if (kind !== undefined && !kinds.includes(kind as string)) {
    return `${where}.${key} must be one of ${kinds.join(', ')}`
  }
  return colorError(value.color, where)
}

// Checks a face or a patch; the strict reading the gateway applies to what it stores.
export function agentFaceError(value: unknown, patch = false): string | undefined {
  if (!isRecord(value)) {
    return 'face must be an object'
  }
  if (!patch && value.v !== 1) {
    return 'face.v must be 1'
  }
  if (JSON.stringify(value).length > AGENT_FACE_MAX_BYTES) {
    return `face is larger than ${AGENT_FACE_MAX_BYTES} bytes`
  }
  for (const key of Object.keys(value)) {
    if (!['v', 'backdrop', 'tile', ...FACE_PARTS].includes(key)) {
      return `face.${key} is not a face slot`
    }
  }
  if (value.backdrop !== undefined) {
    const error = isRecord(value.backdrop) ? colorError(value.backdrop.color, 'backdrop') : 'backdrop must be an object'
    if (error) {
      return error
    }
  }
  const tile = slotError(value.tile, 'tile', FACE_KINDS.tile, 'shape')
  if (tile) {
    return tile
  }
  for (const part of FACE_PARTS) {
    const error = slotError(value[part], part, FACE_KINDS[part], 'kind')
    if (error) {
      return error
    }
    if (!patch && value[part] !== undefined && (value[part] as Record<string, unknown>).kind === undefined) {
      return `${part}.kind is required`
    }
  }
  return undefined
}

export function isAgentFace(value: unknown): value is AgentFace {
  return agentFaceError(value) === undefined
}

export function mergeAgentFace(face: AgentFace, patch: AgentFacePatch): AgentFace {
  const next: AgentFace = { ...face }
  if (patch.backdrop) {
    next.backdrop = { ...face.backdrop, ...patch.backdrop }
  }
  if (patch.tile) {
    next.tile = { ...face.tile, ...patch.tile }
  }
  for (const part of FACE_PARTS) {
    const layer = patch[part]
    if (layer) {
      const merged = { kind: FACE_KINDS[part][0], ...face[part], ...layer }
      ;(next as Record<FacePart, unknown>)[part] = merged
    }
  }
  return next
}

// What a renderer draws: every slot filled, anything unknown (a newer kit) read as its slot's first kind.
export type ResolvedFace = {
  backdrop: string | undefined
  tile: { shape: FaceTileShape; color: string | undefined }
  antenna: Layer<FaceAntenna>
  visor: Layer<FaceVisor>
  eyes: Layer<FaceEyes>
  mouth: Layer<FaceMouth>
}

function known<K extends string>(kinds: readonly K[], kind: unknown, fallback: K): K {
  return kinds.includes(kind as K) ? (kind as K) : fallback
}

export function resolveAgentFace(face: AgentFace | undefined): ResolvedFace {
  const f: Partial<AgentFace> = isRecord(face) ? face : {}
  const layer = <K extends string>(part: FacePart, kinds: readonly K[], fallback: K): Layer<K> => {
    const held = isRecord(f[part]) ? (f[part] as Layer<string>) : undefined
    return { kind: known(kinds, held?.kind, fallback), ...(typeof held?.color === 'string' ? { color: held.color } : {}) }
  }
  return {
    backdrop: typeof f.backdrop?.color === 'string' ? f.backdrop.color : undefined,
    tile: { shape: known(FACE_KINDS.tile, f.tile?.shape, 'soft'), color: typeof f.tile?.color === 'string' ? f.tile.color : undefined },
    antenna: layer('antenna', FACE_KINDS.antenna, 'none'),
    visor: layer('visor', FACE_KINDS.visor, 'none'),
    eyes: layer('eyes', FACE_KINDS.eyes, 'bar'),
    mouth: layer('mouth', FACE_KINDS.mouth, 'none'),
  }
}

function rng(seed: string): () => number {
  let s = fnv1a(seed)
  return () => (s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296
}

// Deterministic per seed. The head, visor and backdrop stay on the project swatch (stored as `project`, so they follow
// it); one accent swatch other than the project's lights the antenna tip and the eyes.
export function rollFace(seed: string, project: FaceSwatch): AgentFace {
  const r = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const glow = pick(FACE_SWATCHES.filter((s) => s !== project && s !== 'steel'))
  const visor = pick<FaceVisor>(['none', 'band', 'band', 'inset'])
  const steel = visor === 'none' && r() < 0.5
  const vivid = steel && r() < 0.6
  const shape = pick<FaceTileShape>(['soft', 'soft', 'squircle', 'boxy'])
  const antenna = pick<FaceAntenna>(['ball', 'ball', 'triangle', 'square', 'diamond', 'twin', 'none'])
  const antennaColor = pick([glow, glow, 'project'])
  const eyes = pick<FaceEyes>(['bar', 'bar', 'split', 'segments', 'slit'])
  const mouth = pick<FaceMouth>(['grill', 'grill', 'vent', 'speaker', 'none'])
  const mouthColor = pick([glow, 'project'])
  return {
    v: 1,
    ...(vivid ? { backdrop: { color: 'project/base' } } : {}),
    tile: { shape, ...(steel ? { color: 'steel' } : {}) },
    antenna: { kind: antenna, color: antennaColor },
    visor: { kind: visor },
    eyes: { kind: eyes, color: glow },
    mouth: { kind: mouth, color: mouthColor },
  }
}

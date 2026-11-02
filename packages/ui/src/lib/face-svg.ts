import {
  FACE_SWATCHES,
  FACE_TONES,
  fnv1a,
  projectSwatch,
  resolveAgentFace,
  resolveFaceColor,
  type AgentFace,
  type FaceSwatch,
  type FaceTone,
  type SessionInfo,
  type SessionRow,
  type SessionState,
} from '@workerdeck/protocol'

// The face drawn as SVG markup, shared by the React avatar and hosts that need a file (VS Code's tab icon). Every value
// interpolated below is a number or a known swatch and tone name, never free text.

export type FaceState = 'idle' | 'asleep' | 'starting' | 'working' | 'attention' | 'failed' | 'closed'
export type FaceTheme = 'dark' | 'light'

export const CONTEXT_WRAP_UP_DEFAULT = 0.4

export function faceProjectOf(info: SessionInfo): FaceSwatch {
  return projectSwatch(info.project?.root ?? info.cwd ?? info.id)
}

// The pose a face draws: the row's state (or the one a folded lead stands in with) refined by the session's status.
export function faceStateOf(row: SessionRow, state: SessionState = row.state): FaceState {
  const { info } = row
  if (state === 'attention') {
    return 'attention'
  }
  if (state === 'ended') {
    return info.status === 'failed' ? 'failed' : 'closed'
  }
  if (state === 'working') {
    return info.status === 'starting' ? 'starting' : 'working'
  }
  return info.engineAsleep ? 'asleep' : 'idle'
}

export const FACE_HUES: Record<FaceSwatch, number> = {
  blue: 250,
  indigo: 278,
  violet: 302,
  rose: 355,
  coral: 32,
  copper: 58,
  amber: 82,
  olive: 120,
  green: 152,
  mint: 174,
  teal: 205,
  steel: 250,
}

export const FACE_TONE_VALUES: Record<FaceTheme, Record<FaceTone, [number, number]>> = {
  dark: {
    wash: [0.34, 0.05],
    base: [0.64, 0.095],
    deep: [0.48, 0.08],
    soft: [0.82, 0.05],
    glow: [0.86, 0.15],
    screen: [0.25, 0.025],
    ink: [0.23, 0.03],
  },
  light: {
    wash: [0.91, 0.045],
    base: [0.7, 0.11],
    deep: [0.54, 0.1],
    soft: [0.93, 0.04],
    glow: [0.8, 0.16],
    screen: [0.3, 0.03],
    ink: [0.27, 0.035],
  },
}

const OVERLAY_COLORS: Record<FaceTheme, Record<'bubble' | 'ink' | 'danger' | 'zz' | 'spark', string>> = {
  dark: { bubble: '#f5a623', ink: '#1a1c22', danger: '#f14c4c', zz: '#aab3c4', spark: '#ffd66b' },
  light: { bubble: '#f0a020', ink: '#1a1c22', danger: '#d93036', zz: '#7d8799', spark: '#e0a91c' },
}

export function faceOklch(swatch: FaceSwatch, tone: FaceTone, theme: FaceTheme): string {
  const [l, c] = FACE_TONE_VALUES[theme][tone]
  return `oklch(${l} ${(swatch === 'steel' ? c * 0.18 : c).toFixed(3)} ${FACE_HUES[swatch]})`
}

// The `--sw-<swatch>-<tone>` and `--face-*` custom properties for one theme, as declarations.
export function faceThemeDeclarations(theme: FaceTheme): string {
  const tones = FACE_SWATCHES.flatMap((swatch) => FACE_TONES.map((tone) => `--sw-${swatch}-${tone}: ${faceOklch(swatch, tone, theme)};`))
  const overlays = Object.entries(OVERLAY_COLORS[theme]).map(([name, value]) => `--face-${name}: ${value};`)
  return [...tones, ...overlays].join('\n')
}

export type FaceSvgOptions = {
  face: AgentFace | undefined
  project: FaceSwatch
  state?: FaceState
  size: number
  // Unique per drawn instance: clip paths are document-global ids.
  id: string
  // Context use 0 to 1; absent draws no fill.
  context?: number
  // At or above it the fill turns to the wrap-up warning.
  threshold?: number
  // A seed for the per-agent animation offset (the agent id), so a list never blinks in unison.
  phase?: string
  // A literal theme for a standalone file; absent paints with the CSS custom properties.
  theme?: FaceTheme
}

const RADIUS = { soft: 6, squircle: 9, boxy: 3.5 } as const

function waveTop(amp: number): string {
  return `M-8 0 q2 ${-amp} 4 0 t4 0${' t4 0'.repeat(12)}`
}

export function faceRadiusPx(size: number): number {
  return size === 40 || size === 32 ? 4 : size * 0.1
}

const Z1 = 'M24 2.2h3.2l-3.2 3.4h3.2'
const Z2 = 'M28.4 -2.4h2.6l-2.6 2.8h2.6'
const SPARK = 'M28 -1.5l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z'
const GLINT = `<rect x="14" y="13" width="3" height="7" fill="#ffffff" opacity=".6"/>`
const DOTS = [22.2, 25.1, 28]

type FaceParts = {
  className: string
  delay: number
  rx: string
  ring: string
  backdrop: string
  liquid?: { tide: string; waves: { kind: string; path: string }[] }
  tileClip: string
  body: string
  eyes: string
  glint?: string
  mouth: string
  overlay: {
    zz?: string
    bubble?: string
    failed?: string
    spark?: string
    pill?: string
    dot?: string
  }
}

function faceParts(options: FaceSvgOptions): FaceParts {
  const { size, theme } = options
  const state = options.state ?? 'idle'
  const face = resolveAgentFace(options.face)
  const color = (ref: string | undefined, tone: FaceTone): string => {
    const resolved = resolveFaceColor(ref, options.project, tone)
    return theme ? faceOklch(resolved.swatch, resolved.tone, theme) : `var(--sw-${resolved.swatch}-${resolved.tone})`
  }
  const swatchTone = (ref: string | undefined, tone: FaceTone): string => color((ref ?? 'project').split('/')[0], tone)
  const overlay = (name: keyof (typeof OVERLAY_COLORS)['dark']): string => (theme ? OVERLAY_COLORS[theme][name] : `var(--face-${name})`)
  const rx = ((faceRadiusPx(size) * 32) / size).toFixed(2)
  const small = size < 24
  const pose = state === 'asleep' || state === 'closed' ? 'closed' : state === 'failed' ? 'x' : 'open'
  const tileColor = face.tile.color
  const tile = (attrs: string) => `<rect x="3" y="5" width="26" height="24" rx="${RADIUS[face.tile.shape]}" ${attrs}/>`
  const warn = options.context !== undefined && options.context >= (options.threshold ?? 0.4)

  const antenna = (): string => {
    const { kind, color: ref } = face.antenna
    const deep = swatchTone(ref, 'deep')
    const glow = swatchTone(ref, 'glow')
    const stem = `<rect x="15.2" y="1.5" width="1.6" height="5" rx=".8" fill="${deep}"/>`
    switch (kind) {
      case 'ball': {
        return stem + `<rect class="led" x="13.5" y="-1" width="5" height="5" rx="2.5" fill="${glow}"/>`
      }
      case 'square': {
        return stem + `<rect class="led" x="13.7" y="-.8" width="4.6" height="4.6" rx="1.1" fill="${glow}"/>`
      }
      case 'diamond': {
        return (
          stem + `<g transform="rotate(45 16 1.5)"><rect class="led" x="13.9" y="-.6" width="4.2" height="4.2" rx="1" fill="${glow}"/></g>`
        )
      }
      case 'triangle': {
        return (
          stem + `<path class="led" d="M16 -1.2L19 3.4H13Z" fill="${glow}" stroke="${glow}" stroke-width="1.4" stroke-linejoin="round"/>`
        )
      }
      case 'twin': {
        return [10.5, 21.5]
          .map(
            (x) =>
              `<rect x="${x - 0.7}" y="1.8" width="1.4" height="4.5" rx=".7" fill="${deep}"/>` +
              `<rect class="led" x="${x - 2}" y="-.6" width="4" height="4" rx="2" fill="${glow}"/>`,
          )
          .join('')
      }
      default: {
        return ''
      }
    }
  }

  const visor = (): string => {
    const fill = color(face.visor.color, 'screen')
    if (face.visor.kind === 'band') {
      return `<rect x="0" y="11.5" width="32" height="10" fill="${fill}"/>`
    }
    if (face.visor.kind === 'inset') {
      return `<rect x="6" y="11" width="20" height="11" rx="4.5" fill="${fill}"/>`
    }
    return ''
  }

  const eyes = (): { art: string; glint?: string } => {
    const fill = color(face.eyes.color, 'glow')
    if (pose === 'closed') {
      return { art: `<rect x="9" y="16" width="14" height="1.4" rx=".7" fill="${fill}" opacity=".5"/>` }
    }
    if (pose === 'x') {
      return {
        art: [11, 21]
          .map(
            (x) =>
              `<path d="M${x - 1.7} 14.8l3.4 3.4M${x + 1.7} 14.8l-3.4 3.4" stroke="${overlay('danger')}" stroke-width="1.6" stroke-linecap="round"/>`,
          )
          .join(''),
      }
    }
    const painted = (shape: string) => ({
      art: shape.replaceAll('/>', ` fill="${fill}"/>`),
      ...(state === 'working' ? { glint: shape } : {}),
    })
    switch (face.eyes.kind) {
      case 'split': {
        return painted(
          `<rect x="8" y="14.3" width="6.6" height="4.4" rx="2.2"/><rect x="17.4" y="14.3" width="6.6" height="4.4" rx="2.2"/>`,
        )
      }
      case 'slit': {
        return painted(`<rect x="7" y="15.4" width="18" height="2.2" rx="1.1"/>`)
      }
      case 'segments': {
        return {
          art: [0, 1, 2, 3]
            .map(
              (i) => `<rect class="seg" style="--i:${i}" x="${8.1 + i * 4.2}" y="14.3" width="3.2" height="4.4" rx="1.3" fill="${fill}"/>`,
            )
            .join(''),
        }
      }
      default: {
        return painted(`<rect x="8" y="14.3" width="16" height="4.4" rx="2.2"/>`)
      }
    }
  }

  const mouth = (): string => {
    const fill = color(face.mouth.color, 'glow')
    const screen = swatchTone(face.mouth.color, 'screen')
    switch (face.mouth.kind) {
      case 'grill': {
        return (
          `<rect x="11.5" y="22.6" width="9" height="3.4" rx="1.2" fill="${screen}"/>` +
          [13.4, 15.55, 17.7].map((x) => `<rect x="${x}" y="23.3" width=".9" height="2" rx=".45" fill="${fill}" opacity=".85"/>`).join('')
        )
      }
      case 'vent': {
        return (
          `<rect x="10.5" y="22.8" width="11" height="3" rx="1.5" fill="${screen}"/>` +
          [12.3, 14.2, 16.1, 18, 19.9]
            .map((x) => `<rect x="${x - 0.3}" y="23.6" width=".6" height="1.4" rx=".3" fill="${fill}" opacity=".85"/>`)
            .join('')
        )
      }
      case 'speaker': {
        return [11.5, 14.5, 17.5, 20.5]
          .map((x) => `<rect x="${x - 0.9}" y="23.2" width="1.8" height="1.8" rx=".9" fill="${screen}"/>`)
          .join('')
      }
      default: {
        return ''
      }
    }
  }

  const statusOverlay = (): FaceParts['overlay'] => {
    if (small) {
      return {}
    }
    switch (state) {
      case 'asleep': {
        return { zz: `fill="none" stroke="${overlay('zz')}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"` }
      }
      case 'attention': {
        return {
          bubble:
            `<rect x="20.5" y="-3.5" width="12.5" height="10" rx="5" fill="${overlay('bubble')}"/>` +
            `<path d="M22.6 5.4l-1.6 3.1 4.1-2.4z" fill="${overlay('bubble')}"/>` +
            `<rect x="26" y="-1.6" width="1.6" height="4.2" rx=".8" fill="${overlay('ink')}"/>` +
            `<rect x="26" y="3.3" width="1.6" height="1.6" rx=".8" fill="${overlay('ink')}"/>`,
        }
      }
      case 'failed': {
        return {
          failed:
            `<rect x="23.5" y="23.5" width="9.5" height="9.5" rx="4.75" fill="${overlay('danger')}"/>` +
            `<rect x="27.55" y="25.4" width="1.4" height="3.6" rx=".7" fill="#fff"/><rect x="27.55" y="29.7" width="1.4" height="1.4" rx=".7" fill="#fff"/>`,
        }
      }
      case 'starting': {
        return { spark: `fill="${overlay('spark')}"` }
      }
      case 'working': {
        return {
          pill: `<rect x="20" y="-3" width="12" height="7" rx="3.5" fill="${color('steel', 'screen')}"/>`,
          dot: `y="-.3" width="1.8" height="1.8" rx=".9" fill="${color('steel', 'soft')}"`,
        }
      }
      default: {
        return {}
      }
    }
  }

  const liquid = (): FaceParts['liquid'] => {
    if (options.context === undefined) {
      return undefined
    }
    const level = Math.min(1, Math.max(0, options.context))
    const fill = warn ? color('amber', 'base') : swatchTone(face.backdrop, 'deep')
    const wave = (amp: number, kind: string, opacity: number, paint = fill) => ({
      kind,
      path: `d="${waveTop(amp)}V40H-8Z" fill="${paint}" opacity="${opacity}"`,
    })
    return {
      tide: (32 * (1 - level)).toFixed(2),
      waves: [
        warn ? wave(1.1, 'back', 0.7, color('amber', 'glow')) : wave(1.1, 'back', 0.45),
        wave(0.8, 'front', warn ? 1 : 0.9),
        ...(warn ? [{ kind: 'crest', path: `d="${waveTop(0.8)}" fill="none" stroke="${color('amber', 'glow')}" stroke-width="1.1"` }] : []),
      ],
    }
  }

  const { art, glint } = eyes()
  return {
    className: `wd-face st-${state}${warn ? ' warn' : ''}`,
    delay: options.phase ? -(fnv1a(options.phase) % 7000) / 1000 : 0,
    rx,
    ring:
      state === 'attention' && !small
        ? `<rect class="ring" x="-1.4" y="-1.4" width="34.8" height="34.8" rx="${(Number(rx) + 1.4).toFixed(2)}" fill="none" stroke="${overlay('bubble')}" stroke-width="1.2"/>`
        : '',
    backdrop: `<rect x="0" y="0" width="32" height="32" rx="${rx}" fill="${color(face.backdrop, 'wash')}"/>`,
    liquid: liquid(),
    tileClip: tile(''),
    body:
      antenna() +
      tile(`fill="${color(tileColor, 'base')}"`) +
      `<g clip-path="url(#${options.id}-t)"><rect x="0" y="25.5" width="32" height="9" fill="${color(tileColor, 'deep')}" opacity=".35"/>${visor()}</g>` +
      `<rect x="6.5" y="7.4" width="4.2" height="1.5" rx=".75" fill="${color(tileColor, 'soft')}" opacity=".55"/>`,
    eyes: art,
    ...(glint ? { glint } : {}),
    mouth: mouth(),
    overlay: statusOverlay(),
  }
}

function overlaySvg({ zz, bubble, failed, spark, pill, dot }: FaceParts['overlay']): string {
  if (zz) {
    return `<g ${zz}><path class="z1" d="${Z1}"/><path class="z2" d="${Z2}"/></g>`
  }
  if (bubble) {
    return `<g class="bubble">${bubble}</g>`
  }
  if (spark) {
    return `<path class="spark" d="${SPARK}" ${spark}/>`
  }
  if (pill && dot) {
    return `<g>${pill}${DOTS.map((x) => `<rect class="dot" x="${x}" ${dot}/>`).join('')}</g>`
  }
  return failed ?? ''
}

export function faceSvg(options: FaceSvgOptions): string {
  const p = faceParts(options)
  const { id } = options
  const liquid = p.liquid
    ? `<clipPath id="${id}-f"><rect x="0" y="0" width="32" height="32" rx="${p.rx}"/></clipPath>` +
      `<g clip-path="url(#${id}-f)"><g class="tide" style="transform:translateY(${p.liquid.tide}px)">` +
      p.liquid.waves.map((w) => `<path class="wave ${w.kind}" ${w.path}/>`).join('') +
      `</g></g>`
    : ''
  const glint = p.glint
    ? `<clipPath id="${id}-v">${p.glint}</clipPath><g clip-path="url(#${id}-v)">${GLINT.replace('<rect ', '<rect class="glint" ')}</g>`
    : ''
  return (
    `<svg class="${p.className}" style="--d:${p.delay}s" width="${options.size}" height="${options.size}" viewBox="0 0 32 32" aria-hidden="true">` +
    `<defs><clipPath id="${id}-t">${p.tileClip}</clipPath></defs>` +
    p.ring +
    p.backdrop +
    liquid +
    `<g transform="translate(3.2 4.6) scale(.8)"><g class="body">` +
    p.body +
    `<g class="eyes">${p.eyes}${glint}</g>` +
    p.mouth +
    `</g></g>` +
    overlaySvg(p.overlay) +
    `</svg>`
  )
}

function art(inner: string): string {
  return `<svg viewBox="0 0 32 32" width="32" height="32">${inner}</svg>`
}

function layer(cls: string, inner: string, style?: string): string {
  return `<span class="${cls}"${style ? ` style="${style}"` : ''}>${inner}</span>`
}

function overlayLayers({ zz, bubble, failed, spark, pill, dot }: FaceParts['overlay']): string {
  if (zz) {
    return layer('z1', art(`<path d="${Z1}" ${zz}/>`)) + layer('z2', art(`<path d="${Z2}" ${zz}/>`))
  }
  if (bubble) {
    return layer('bubble', art(bubble))
  }
  if (spark) {
    return layer('spark', art(`<path d="${SPARK}" ${spark}/>`))
  }
  if (pill && dot) {
    return layer('dots', art(pill) + DOTS.map((x) => layer('dot', art(`<rect x="${x}" ${dot}/>`))).join(''))
  }
  return failed ? art(failed) : ''
}

// The same face as `faceSvg`, with every part that animates a transform lifted into its own HTML layer: Chromium never
// composites a transform animation inside SVG at a device scale above 1, so the SVG form repaints the page every frame.
// Sizes scale the geometry through `--k`, never a transform on the root, which costs a render pass per face per frame.
export function faceHtml(options: FaceSvgOptions): string {
  const p = faceParts(options)
  const { id, size } = options
  const liquid = p.liquid
    ? layer(
        'liquid',
        layer(
          'tide',
          p.liquid.waves.map((w) => layer(`wave ${w.kind}`, art(`<path ${w.path}/>`))).join(''),
          `transform:translateY(${((Number(p.liquid.tide) * size) / 32).toFixed(2)}px)`,
        ),
        `border-radius:${faceRadiusPx(size)}px`,
      )
    : ''
  const glint = p.glint ? layer('lens', layer('glint', art(GLINT)), `clip-path:url(#${id}-v)`) : ''
  const lens = p.glint ? `<clipPath id="${id}-v"${size === 32 ? '' : ` transform="scale(${size / 32})"`}>${p.glint}</clipPath>` : ''
  const eyes = layer('eyes', art(p.eyes + lens) + glint)
  return (
    `<span class="${p.className}" style="--d:${p.delay}s;--k:${size / 32}" aria-hidden="true">` +
    art(p.ring + p.backdrop) +
    liquid +
    layer('frame', layer('body', art(`<defs><clipPath id="${id}-t">${p.tileClip}</clipPath></defs>${p.body}`) + eyes + art(p.mouth))) +
    overlayLayers(p.overlay) +
    `</span>`
  )
}

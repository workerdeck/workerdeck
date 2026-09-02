/*
 * Builds `build/scoped.css` — the self-contained, scope-rewritten stylesheet behind the
 * `@workerdeck/ui/scoped.css` export, for a host whose own Tailwind v4 design system `theme.css`
 * would collide with. The package compiles its OWN utilities from its OWN theme and sources,
 * then rewrites every selector to live under `.wd-root`.
 *
 * **Every rewrite adds exactly one class of specificity (0,1,0), uniformly** — that is what keeps
 * the package's internal cascade bit-for-bit identical to the standalone build, and it is the
 * invariant any new selector form must satisfy. Rationale in docs/PACKAGES.md §`packages/ui`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '.wd-root'
const ENTRY = join(pkgRoot, 'src/styles/scoped.entry.css')
const OUT = join(pkgRoot, 'build/scoped.css')

/* ── Selector rewriting ───────────────────────────────────────────────── */

// Nodes of the first compound (everything before the first combinator).
function splitFirstCompound(selector) {
  const first = []
  let rest = null
  for (const node of selector.nodes) {
    if (rest !== null) {
      rest.push(node)
    } else if (node.type === 'combinator') {
      rest = [node]
    } else {
      first.push(node)
    }
  }
  return { first, rest: rest ?? [] }
}

function stringify(nodes) {
  return nodes.map((n) => String(n)).join('')
}

// `[data-theme='x']` (exactly, alone in its compound) → the theme value.
function themeAttrValue(compound) {
  if (compound.length !== 1) {
    return null
  }
  const node = compound[0]
  if (node.type !== 'attribute' || node.attribute !== 'data-theme') {
    return null
  }
  return node.value?.replace(/^['"]|['"]$/g, '') ?? null
}

// A whole-selector `[data-theme='X']` token block. The rewritten forms keep the
// original cascade: the light block precedes the dark block in source, both at
// equal specificity, so with no attribute the panel is light, and the dark
// ancestor form wins its tie against the light base by source order. Self-pins
// (`.wd-root[data-theme]`) carry one extra attribute of specificity so a panel
// pinned light under a dark document stays light.
function mapThemeTokenBlock(value) {
  if (value === 'dark') {
    return [`${SCOPE}:where([data-theme='dark'], [data-theme='dark'] *)`, `${SCOPE} [data-theme='dark']`]
  }
  return [`${SCOPE}[data-theme='${value}']`, `${SCOPE} [data-theme='${value}']`]
}

const ROOTISH = new Set([':root', ':host', 'html', 'body'])

function transformSelectors(selectorText) {
  const root = selectorParser().astSync(selectorText, { lossless: false })
  const out = []
  for (const selector of root.nodes) {
    const text = String(selector).trim()
    if (text.startsWith(SCOPE)) {
      out.push(text) // idempotency — never double-scope
      continue
    }
    const { first, rest } = splitFirstCompound(selector)
    const firstText = stringify(first)
    const restText = stringify(rest)

    // `:root` / `html` / `body` / `:host` — the element IS the scope root now.
    if (ROOTISH.has(firstText)) {
      out.push(`${SCOPE}${restText}`)
      continue
    }

    const theme = themeAttrValue(first)
    if (theme !== null) {
      if (rest.length === 0) {
        // A token block: declarations must land on the wrapper (and on nested
        // pins), driven by an attribute that may live above it.
        out.push(...mapThemeTokenBlock(theme))
      } else {
        // Ancestor form (`[data-theme='light'] [data-terminal]`): the attribute
        // sits on the host's <html>, ABOVE the wrapper — gate the next compound
        // on ancestor-or-self instead of nesting the attribute inside.
        const restSel = selectorParser().astSync(restText, { lossless: false }).nodes[0]
        const { first: restFirst, rest: restRest } = splitFirstCompound(restSel)
        out.push(`${SCOPE} ${stringify(restFirst)}:where([data-theme='${theme}'], [data-theme='${theme}'] *)${stringify(restRest)}`)
      }
      continue
    }

    // Universal or bare-pseudo first compound (`*`, `::before`, `:focus-visible`,
    // `:where(svg.lucide)`): substitute the implicit `*` with the scope, keeping
    // added specificity at exactly one class like every other rewrite.
    const universal = first.length > 0 && first[0].type === 'universal'
    const pseudoFirst = first.length > 0 && first[0].type === 'pseudo'
    if (universal || pseudoFirst || first.length === 0) {
      const compound = universal ? stringify(first.slice(1)) : firstText
      out.push(`:is(${SCOPE}, ${SCOPE} *)${compound}${restText}`)
      continue
    }

    // Everything else: plain descendant prefix.
    out.push(`${SCOPE} ${text}`)
  }
  return [...new Set(out)].join(', ')
}

const SKIP_ATRULES = /^(-\w+-)?(keyframes|font-face|property|page|counter-style)$/

function insideSkippedAtRule(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && SKIP_ATRULES.test(parent.name)) {
      return true
    }
  }
  return false
}

/* ── Cross-namespace guards ───────────────────────────────────────────────
 * Our font-size utility names, guarded with `color: inherit` at the TOP of the
 * utilities layer: a host `--color-X` of the same name turns its `.text-X` into
 * a color utility (specificity 0,1,0) that would otherwise paint our text runs.
 * `color: inherit` is what "no rule" computes to, and the guard's position —
 * first in the layer — means any of our own color utilities on the same element
 * still win their specificity tie by source order. */
const TEXT_SCALE_NAMES = [
  'display-xl',
  'display-lg',
  'display-md',
  'display-sm',
  'heading-1',
  'heading-2',
  'heading-3',
  'body',
  'body-sm',
  'label',
  'micro',
  'code',
]

const scopePlugin = {
  postcssPlugin: 'wd-scope',
  Once(cssRoot) {
    cssRoot.walkRules((rule) => {
      if (insideSkippedAtRule(rule)) {
        return
      }
      rule.selector = transformSelectors(rule.selector)
    })

    const used = new Set()
    cssRoot.walkRules((rule) => {
      for (const name of TEXT_SCALE_NAMES) {
        if (rule.selector.includes(`.text-${name}`)) {
          used.add(name)
        }
      }
    })
    if (used.size > 0) {
      cssRoot.walkAtRules('layer', (atRule) => {
        if (atRule.params !== 'utilities' || atRule.nodes === undefined) {
          return
        }
        const guard = postcss.rule({
          selector: [...used].map((name) => `${SCOPE} .text-${name}`).join(', '),
        })
        guard.append(postcss.decl({ prop: 'color', value: 'inherit' }))
        atRule.prepend(guard)
        return false // first utilities layer only
      })
    }
  },
}
/* The entry `@source`s streamdown's dist (pnpm nests it under this package).
 * If dependency layout ever changes, fail loudly rather than silently shipping
 * a stylesheet with unstyled markdown. */
if (!existsSync(join(pkgRoot, 'node_modules/streamdown/dist'))) {
  console.error('scoped.css: node_modules/streamdown/dist not found — fix the @source path in scoped.entry.css')
  process.exit(1)
}

/* `@tailwindcss/postcss` resolves `@import`/`@source` relative to the entry
 * file, exactly as the CLI would; the scope plugin then rewrites its output
 * in the same pipeline. */
const result = await postcss([tailwindcss(), scopePlugin]).process(readFileSync(ENTRY, 'utf8'), {
  from: ENTRY,
  map: false,
})

const banner = `/*!
 * @workerdeck/ui — scoped stylesheet for embedding in a host app that has its
 * own design system. Generated by scripts/build-scoped-css.mjs; do not edit.
 *
 * Usage:  import '@workerdeck/ui/scoped.css'
 *         <div className="wd-root">…<SessionPanel/>…</div>
 *
 * Everything in here is scoped under .wd-root — do NOT also @source-scan this
 * package or import theme.css into your own Tailwind build.
 */
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, banner + result.css)

/* ── Self-check: nothing global may survive ───────────────────────────── */

const verify = postcss.parse(result.css)
const offenders = []
verify.walkRules((rule) => {
  if (insideSkippedAtRule(rule)) {
    return
  }
  for (const sel of rule.selectors) {
    const s = sel.trim()
    if (!s.includes('.wd-root')) {
      offenders.push(s)
    }
  }
})
if (offenders.length > 0) {
  rmSync(OUT)
  console.error('scoped.css: unscoped selectors survived the rewrite:')
  for (const s of offenders.slice(0, 20)) {
    console.error(`  ${s}`)
  }
  process.exit(1)
}

console.log(`scoped.css: ${(result.css.length / 1024).toFixed(1)}kB, all selectors scoped`)

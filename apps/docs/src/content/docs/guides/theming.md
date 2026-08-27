---
title: Theming & styling
description: Three tiers of visual control — token overrides, className props, and source imports — from a quick re-skin to a fully custom component tree.
order: 11
---

WorkerDeck's UI is designed for embedding, and embedders need different levels of visual control.
The package offers three tiers, from lightest to deepest:

1. **CSS token overrides** — change colours, type, spacing, geometry with one block of CSS.
2. **`className` and `data-slot`** — restyle any component or sub-element without forking.
3. **Source imports** — consume the raw `.tsx` files as your own code.

Every tier composes: start with tokens, add targeted `className` overrides where tokens don't
reach, and fall through to source only for the components you truly need to rewrite.

---

## Tier 1: CSS custom property tokens

Every visual decision in `@workerdeck/ui` is driven by CSS custom properties. Override them on
`.wd-root` (scoped mode) or `:root` (full-page mode) and the entire UI follows.

### Colour tokens (swap by `[data-theme]`)

These are the ones most embedders override. Set them inside `[data-theme='light']` and
`[data-theme='dark']` blocks (or on `.wd-root` to pin one theme):

| Token | What it paints |
| --- | --- |
| `--bg` | Page / panel background |
| `--bg-surface` | Cards, elevated surfaces |
| `--bg-surface-hover` | Surface hover fill |
| `--bg-code` | Code block backgrounds |
| `--border`, `--border-light`, `--border-strong` | Border hierarchy |
| `--fg-1` through `--fg-4` | Text hierarchy (1 = primary, 4 = disabled) |
| `--accent` | Primary action colour (buttons, links, rings) |
| `--accent-hover`, `--accent-dim`, `--accent-bg` | Accent variants |
| `--accent-fg` | Text on accent fills |
| `--sidebar` | Sidebar / list background |
| `--row-hover`, `--row-active`, `--row-selected`, `--row-selected-weak` | List row states |
| `--success`, `--warning`, `--danger`, `--info` | Semantic colours |
| `--success-bg`, `--warning-bg`, `--danger-bg`, `--info-bg` | Semantic tint backgrounds |
| `--vendor-claude`, `--vendor-openai` | Engine brand marks |

Example — match your app's brand:

```css
.wd-root {
  --accent: #6366f1;           /* indigo primary */
  --accent-hover: #4f46e5;
  --accent-bg: #eef2ff;
  --accent-fg: #ffffff;
  --accent-ring: #6366f133;
}
[data-theme='dark'] .wd-root {
  --accent-bg: #1e1b4b;
}
```

### Typography tokens

| Token | Default | What it controls |
| --- | --- | --- |
| `--cw-font-sans` | Inter, system-ui, ... | UI typeface |
| `--cw-font-mono` | JetBrains Mono, ui-monospace, ... | Code / terminal typeface |
| `--text-body` | 0.9375rem (15px) | Base text size |
| `--text-body-sm` | 0.8125rem (13px) | Secondary text |
| `--text-label` | 0.75rem (12px) | Labels, metadata |
| `--text-code` | 0.84375rem (~13.5px) | Code blocks |

### Geometry tokens

These control layout dimensions embedders commonly want to adjust:

| Token | Default | What it sizes |
| --- | --- | --- |
| `--wd-status-bar-height` | `38px` | Height of the status bar |
| `--wd-composer-padding` | `12px` | Padding around the composer area |
| `--wd-transcript-row-gap` | `0px` | Gap between transcript rows |
| `--wd-transcript-max-width` | `48rem` | Max width of transcript content column |

```css
/* Compact status bar for a narrow dock */
.wd-root {
  --wd-status-bar-height: 32px;
  --wd-composer-padding: 8px;
}
```

### Radii, motion, shadows

| Token | Default |
| --- | --- |
| `--radius-sm` / `--radius-md` / `--radius-lg` | 4px / 6px / 8px |
| `--motion-fast` / `--motion-base` / `--motion-slow` | 120ms / 150ms / 220ms |
| `--shadow-xs` through `--shadow-lg` | Elevation ramp (flat by default, shadows for overlays) |

### Token stability

Tokens prefixed `--wd-` are **public API** and follow semver. The unprefixed colour and
typography tokens (`--bg`, `--accent`, `--fg-1`, `--cw-font-sans`, etc.) are stable in practice
and documented here as the theming surface, but new tokens may be added in minor releases.

---

## Tier 2: className props and data-slot selectors

Every exported component accepts a `className` prop on its root element, merged via
`tailwind-merge` so your classes win ties. For sub-elements, every component emits a `data-slot`
attribute you can target with CSS.

### className on the root

```tsx
<SessionPanel
  className='rounded-xl shadow-lg'
  client={client}
  sessionId={sessionId}
/>

<StatusBar
  className='border-b-0 bg-transparent'
  state={state}
/>

<ToolCallCard
  className='border-none bg-surface'
  item={item}
/>
```

### data-slot selectors

Every component carries a `data-slot` attribute naming what it is. Use these as CSS selectors
to reach inside a composite without forking it:

```css
/* Restyle tool cards inside the panel */
.wd-root [data-slot='tool-call'] {
  border-radius: 12px;
  border-color: var(--border-light);
}

/* Tighten the status bar's internal padding */
.wd-root [data-slot='status-bar'] {
  padding: 4px 8px;
}

/* Restyle the composer */
.wd-root [data-slot='composer'] {
  background: var(--bg-surface);
  border-radius: 12px;
}

/* Change the session list item shape */
.wd-root [data-slot='session-item'] {
  border-radius: 8px;
}
```

### Available data-slot values

These are the stable slot names you can target:

**Layout:** `session-panel`, `session-workspace`, `status-bar`, `status-line`

**Transcript:** `transcript-rows`, `transcript-hold`, `message`, `message-content`, `reasoning`,
`tool-call`, `file-delivered`, `loader`, `notice`, `recap`, `turn-result`, `brief`, `catch-up`

**Interaction:** `composer`, `permission-prompt`, `question-prompt`

**Session list:** `session-browser`, `session-list`, `session-list-item`, `session-item`

**Primitives:** `button`, `badge`, `card`, `input`, `textarea`, `select-trigger`, `select-content`,
`select-item`, `menu-content`, `menu-item`, `dialog-content`, `tooltip-content`, `code-block`,
`splitter`, `progress-ring`

---

## Tier 3: Source imports

The npm package ships `src/` alongside `build/`, and `package.json` declares an
`@workerdeck/source` condition on every export. A bundler configured to resolve that condition
imports the raw TypeScript source:

```json
// vite.config.ts (or equivalent)
{
  resolve: {
    conditions: ['@workerdeck/source']
  }
}
```

With that condition active, `import { SessionPanel } from '@workerdeck/ui'` resolves to
`packages/ui/src/index.ts` — the actual `.tsx` files, compiled by your own build. You get:

- **Full tree-shaking** — only the components you use are compiled.
- **Your own Tailwind build** processes the classes, so overriding at the utility level works
  natively.
- **You can copy and modify** any component into your own tree, importing the rest from the
  package. The internal seams (`cn`, the format utilities, the transcript variant context) are
  all exported.

This is the escape hatch for when tokens and `className` are not enough: copy `StatusBar.tsx`
into your project, reshape it, and import everything else from the package.

### The headless layer

If you want to build the entire UI from scratch, skip `@workerdeck/ui` entirely and build on
`@workerdeck/react`:

```tsx
import { useClaudeSession, type TranscriptState } from '@workerdeck/react'

function MyPanel({ client, sessionId }) {
  const { state, sendMessage, approve, deny, interrupt } = useClaudeSession(client, sessionId)
  // state.items, state.status, state.model, state.permissionRequests, ...
  // render however you want
}
```

The hook attaches, folds events through a pure reducer, and hands back live state plus the
control surface. The framework-free reducer (`applyEvent`, `initialTranscriptState`) is also
exported for non-React use.

---

## Quick reference: which tier for what

| Goal | Tier |
| --- | --- |
| Match my app's colour palette | 1 — override `--accent`, `--bg`, `--fg-*` |
| Use my own fonts | 1 — override `--cw-font-sans`, `--cw-font-mono` |
| Adjust spacing / sizing | 1 — override `--wd-*` geometry tokens |
| Restyle one component's root | 2 — `className` prop |
| Restyle a sub-element (e.g. tool card header) | 2 — `[data-slot]` CSS selector |
| Reshape a component's structure | 3 — source import, copy, modify |
| Build a fully custom UI | 3 — `@workerdeck/react` headless hook |

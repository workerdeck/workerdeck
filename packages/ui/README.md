# @workerdeck/ui

Styled agent-control component library for WorkerDeck hosts: `SessionPanel` (status bar +
streaming transcript + tool-call cards + permission prompts + composer with attachments and
`@file` / `/command` completion, plus the panels behind it — session info, context, plan usage,
MCP servers, project files), `SessionWorkspace` (a VS Code-shaped layout *around* that panel —
file tree, editor tabs, Monaco — at `@workerdeck/ui/workspace`, so Monaco stays out of hosts that
don't want it), `SessionList`, and the underlying primitives (Button, Badge,
Card, Select, Dialog, AlertDialog, …). Built on **Tailwind v4 + Base UI + cva**, themed by CSS
tokens with light/dark via `<html data-theme>`.

Everything `SessionPanel` offers is gated on the session's **engine capability record**, so the
same component is correct for a Claude, Codex or provider session without the host branching:
a control the engine can't honor is absent rather than present-and-failing.

The headless layer (`useClaudeSession`, transcript reducer) lives in `@workerdeck/react`;
this package is the styling opinion on top.

## Consumer wiring (Tailwind v4)

The package ships **source styles + source classnames** — your app's Tailwind build compiles
them. Three steps:

1. Your Tailwind entry CSS:

```css
@import 'tailwindcss';
@import '@workerdeck/ui/theme.css';
/* Let Tailwind see this package's classnames (node_modules is not scanned by default). */
@source '../node_modules/@workerdeck/ui';
/* streamdown (the markdown renderer) also styles itself with Tailwind classes, split across
 * chunk files — scan its whole dist dir. With npm/yarn it's hoisted to node_modules/streamdown;
 * with pnpm it's nested under this package: */
@source '../node_modules/@workerdeck/ui/node_modules/streamdown/dist';
```

Inside this monorepo, point `@source` at the package source instead:
`@source '../../packages/ui/src';` plus
`@source '../../packages/ui/node_modules/streamdown/dist';`

2. Set the theme attribute before first paint (no-flash), e.g. in `index.html`:

```html
<script>
  ;(function () {
    var t = localStorage.getItem('my-app.theme')
    var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  })()
</script>
```

3. Fonts (optional but recommended): the tokens reference Inter + JetBrains Mono with safe
fallbacks. Import `@fontsource/inter/{400,500,600,700}.css` and
`@fontsource/jetbrains-mono/{400,500,600}.css` in your app to get the real faces.

## Usage

```tsx
import { WorkerDeckClient } from '@workerdeck/client'
import { SessionPanel } from '@workerdeck/ui'

const client = new WorkerDeckClient({ baseUrl: `${location.origin}/v1` })

<SessionPanel key={sessionId} client={client} sessionId={sessionId} />
```

### The workspace (optional)

`SessionWorkspace` wraps that same panel in a three-region layout — project tree on the left,
open files above, agent below — and is **strictly additive**: `SessionPanel` is untouched and
still complete on its own, so pick whichever fits. An app with its own file tree keeps the panel.

It lives at its **own entry point**, and Monaco is an **optional peer dependency** — install it
alongside `@workerdeck/ui` if you want the workspace, and skip both if you don't:

```sh
npm install monaco-editor
```

```tsx
import { SessionWorkspace } from '@workerdeck/ui/workspace'

<SessionWorkspace key={sessionId} client={client} sessionId={sessionId} />
```

It needs the gateway's host-filesystem routes (`hostFiles` in the server config); without them
the rail is simply absent and you get the panel. Editing additionally needs `hostFiles.write`,
which is a separate opt-in and defaults **off** — the editor reads `/fs/roots` and renders
read-only when it's not enabled. Saves are conditional on the hash the tab read, so a save that
collides with the agent's own edit is refused (409) and offered as a choice rather than silently
winning.

**If you bundle with Vite, you need one line** — the workspace uses Monaco, which reaches its
web workers with `new Worker(new URL(…, import.meta.url))`. Rollup resolves that at build time,
but Vite's dev dep-optimizer rewrites the package into `.vite/deps/` and breaks the relative URL;
Monaco then *silently* runs worker code on the main thread:

```ts
// vite.config.ts
export default defineConfig({ optimizeDeps: { exclude: ['monaco-editor'] } })
```

Monaco is loaded through a dynamic `import()`, so it costs nothing at runtime until a file is
opened. Our own dashboard additionally aliases away Monaco's four worker-backed language services
(TypeScript/JSON/CSS/HTML) — 8.8MB of build output for IntelliSense and schema validation, with
syntax highlighting unaffected — see `packages/web/vite.config.ts` if you want the same trade.

None of this reaches you through the root entry. That separation is why the workspace has its own
subpath rather than living in `@workerdeck/ui`: tree-shaking alone is not enough. Rollup does drop
`CodeEditor` from a `SessionPanel`-only bundle, but Vite resolves Monaco's worker URLs while
*transforming* the module — before tree-shaking runs — and emits ~9MB of worker assets that are
never retracted. Keeping Monaco unreachable from the root entry is what actually prevents that.

Every component takes `className` and carries `data-slot` attributes for targeted overrides.

`SessionPanel` is self-sufficient for errors: a `protocol_error` (the gateway or CLI refusing a
command — a `set_permission_mode` a provider engine can't run, say) renders as a dismissible strip
inside the panel. You do **not** need to mount anything else to see them. `Toaster` is exported
for your own `toast()` calls; the panel never depends on it, because an error channel a host can
lose by forgetting a second mount isn't one.

## Caveats

- Token names are unprefixed (`--bg`, `--accent`, `--primary`, …) and `theme.css` styles
  `body`/focus rings. Embedding into an app with its own conflicting design system may need
  scoping — file an issue with your case.
- Dark mode is driven **only** by `[data-theme='dark']` on the root element (the Tailwind
  `dark:` variant is remapped to it); `prefers-color-scheme` is not consulted at CSS level.
- The session surface centers its content at `--wd-transcript-max-width` (default `48rem`).
  Embedders in narrow docks (a VS Code bottom panel, a drawer) set it to `100%` for
  edge-to-edge content. Other geometry tokens: `--wd-status-bar-height`, `--wd-composer-padding`,
  `--wd-transcript-row-gap`. Every component also carries `data-slot` attributes for targeted
  overrides — e.g. `[data-slot='composer-hint']` is the "Enter to send" line, which a host
  whose vertical space is precious can `display: none`.
- `SessionPanel` can hand its dialog surfaces to the embedder: `panelSurface: 'external'`
  renders no dialogs and no `⋯` menu — every affordance that would open one calls
  `onOpenPanel(panel)` instead, and `onVitals` streams the live readings (status, context,
  rate limits, capabilities) those external surfaces need, so host chrome never has to
  attach a second time (the tool bridge asks the first attached client). The VS Code
  extension's sidebar sections are the reference consumer.
- `statusSurface: 'external'` is the separate opt-out for the **status bar itself**, for a host
  whose chrome already has a status line (VS Code's window bar): the panel draws no bar and the
  readings leave through `onVitals` as before. The two flags are independent, with one coupling
  — the `⋯` menu lives in the bar's trailing slot, so `statusSurface: 'external'` alongside
  `panelSurface: 'internal'` must pass a **function** `header` for the menu to land in.
  Whatever draws the bar owes the panel's own rule: `SessionVitals.connection` wins the status
  slot whenever it isn't `'live'`, because a session status held over a dropped socket is a
  stale reading presented as a current one.
- `@workerdeck/ui/format` is a third entry point carrying the pure formatters (`45.2k`,
  `2h 10m`) with no React in the graph — for a host that renders session readings outside
  React, like an extension host drawing them into a window status bar, and wants them spelled
  exactly as the panel spells them.

## Rules you cannot infer from the types

- **Remount `SessionPanel` by key when the session id changes**, and never let its position in the
  tree change otherwise: a remount drops the WebSocket attach and the whole transcript. That is why
  the workspace keeps the panel's child index across the editor appearing and disappearing.
- **The panel owns the session's one attach.** External chrome reads live values through
  `onVitals` and changes them through `onControls`; opening a second attach to render a status bar
  means the tool bridge may ask the wrong client.
- **`transcriptVariant` and `transcriptDensity` ride context, not props.** A row component composed
  by hand still gets the right treatment; restyling `data-slot`s from outside is not the seam.
- **`statusSurface: 'external'` takes the `⋯` menu's only home with it.** Combining it with
  `panelSurface: 'internal'` needs a *function* `header` to receive the menu, or those panels
  become unreachable.
- **The terminal theme (`variant: 'terminal'`) is a renderer, not a second set of branches.** It
  draws every row itself from `components/terminal/` and the shell mounts it *instead* of the
  components under `components/agent/`, so nothing in there asks which variant it is in — if it is
  drawing at all, it is drawing cards.
- **The panel mounts three terminal surfaces, and they must agree.** The transcript, the pending
  prompts and the composer each establish their own cell, because each sits in a different part of
  the flex column. `terminalMetrics` is one prop for exactly that reason: hand two of them
  different numbers and the caret lands on a different column from the text above it.
- **`transcriptDensity` and `transcriptFont` reach `cards` only.** A terminal has one line height
  and is monospace by construction. Under `terminal` both are inert rather than broken — a host
  offering them as settings should say so, or hide them (the dashboard hides them).
- **`scrubber` and `stickyPrompt` reach `terminal` only**, and by construction rather than policy.
  Both rest on the theme's premise — one line height and one cell make a row's height computable —
  and under `cards` the flags are inert.
- **`stickyPrompt` pins the real row, not a copy of it.** The prompt at the top of the scroller is
  the same DOM node the transcript already rendered, with its transform clamped to the scroll
  offset. A duplicate header cannot be made to line up with the rows beneath it, which is why this
  is worth the machinery (`rangeExtractor` to keep it mounted, a manual push-off — `position:
  sticky` does nothing on an absolutely positioned element).
- **Terminal row heights are computed, and the cache invalidates by object identity.** The height
  calculator keys a `WeakMap<TranscriptItem, …>` per (width, cell) epoch, which works only because
  the react reducer replaces item objects on every mutation. Mutate a `TranscriptItem` in place and
  you will serve a stale height for a row that has changed. The epoch is rebuilt from a
  `ResizeObserver` on the **content** element, not the scroller — the panel can resize without the
  wrap width moving, since the content column caps at 48rem.
- **An item index is not a virtual row index.** `terminalBlocks` folds consecutive tool calls into
  one row and the catch-up recap splices another, so `scrollToIndex(itemIndex)` lands off by the
  fold on any transcript that has either. Go through `rowIndexForItem`.
- **A row's rendered strings are also its height.** `height.ts` predicts each row's pixel height
  with no DOM, so anything the terminal renderer *writes* must come from the module both sides
  import — `tool-run.ts` for a folded run's summary line, `result-preview.ts` for a collapsed tool
  result and its `… +N` label. Re-spelling either one in the renderer alone desynchronises
  `estimateSize` and the transcript grows a phantom scrollable tail. `dev/height-audit.ts` is the
  gate; it measures against real browser layout, which no jsdom test can do.
- **`pnpm test` here covers the pure modules and nothing else.** That is the split, not an
  omission: which rows exist, what a folded run's line says, how much of a result a collapsed row
  keeps and which marks the rail paints are all string-and-array contracts with no DOM in them,
  and they are where this package's bugs have actually shipped. Geometry — does the rendered row
  come out the height the calculator predicted — is the browser audit above. A test in `test/`
  that wants a DOM belongs in `dev/` instead. `buildClusters` and `railScale` are exported from
  `scrubber.tsx` for the test alone and are deliberately absent from `index.ts`.
- **`affordances={false}` must leave a way to scroll.** The scrubber replaces the native scrollbar
  while it is interactive; with affordances off, the marks stay painted but inert *and the native
  scrollbar comes back*. A rail that kept the scrollbar hidden while refusing the pointer would
  strand the reader.
- **Its two metrics must be whole pixels.** `--term-font-size` and `--term-line` are the character
  cell; a line height of `1.5 x 13px` is 19.5px and puts every other row on a half-pixel, which
  softens the text and shows a seam through the diff bands. Horizontal measures are `ch` and
  vertical measures are whole multiples of `--term-line` — nothing in the theme is a px constant.
- **`--term-bleed` is a contract, not a decoration.** A full-bleed band (a diff hunk, a user
  prompt, a hover fill) cancels it with matched negative margin and padding, so it must equal the
  scroller's own horizontal padding. `TerminalSurface` sets both; a host that pads the scroller
  itself will see bands stop short.
- **Line numbers come from the wire and nowhere else.** A diff renders `protocol`'s `FilePatch`,
  whose hunks are the engine's own; this package has never read the file, so a number it computed
  would be authoritative-looking and wrong. A patch whose hunks all start at 0 (an approval, where
  the edit has not happened yet) renders *without* a number column rather than a column of zeroes.
- **Affordances cost no layout, which is what makes `false` a real option.** The hover fill is a
  background and the copy actions are absolutely-positioned overlays one line tall, so
  `affordances={false}` changes no glyph's position — it is the pure article, not a degraded mode.
- **Keep `monaco-editor` unreachable from `src/index.ts`.** Tree-shaking does not cover it: Vite
  resolves Monaco's worker `new URL(...)`s while *transforming* the module, before shaking, and
  emits megabytes of worker assets it never retracts. That is what the `/workspace` entry point is
  for, and why Vite hosts need `optimizeDeps: { exclude: ['monaco-editor'] }`.


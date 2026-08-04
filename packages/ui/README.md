# @workerdeck/ui

Styled agent-control component library for WorkerDeck hosts: `SessionPanel` (status bar +
streaming transcript + tool-call cards + permission prompts + composer), `SessionList`, and the
underlying primitives (Button, Badge, Card, Select, AlertDialog, …). Built on **Tailwind v4 +
Base UI + cva**, themed by CSS tokens with light/dark via `<html data-theme>`.

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

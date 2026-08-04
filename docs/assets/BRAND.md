# WorkerDeck brand

## The mark — "Session Stack"

Stacked session cards with a live prompt on the front card: the chevron is the
terminal, the green dot is a session running *now*, and the card peeking out
behind is the worker queue — more sessions waiting. It compresses the whole
pitch (embed, watch, and control live Claude Code sessions; run them as jobs)
into one glyph, and stays legible at 16px.

Geometry lives in a 24×24 viewBox at stroke-width 2 (lucide idiom, so it sits
next to lucide icons in the app):

```svg
<path d="M8 3.5h9A3.5 3.5 0 0 1 20.5 7v9" />          <!-- queued card -->
<rect width="13.5" height="13.5" x="3.5" y="7" rx="3.5" /> <!-- live card -->
<path d="m7 16.5 2.5-2.5L7 11.5" />                    <!-- prompt -->
<circle cx="13.2" cy="14" r="1.7" fill="#2fbf71" />    <!-- running dot -->
```

## Color

| Token | Value | Use |
| --- | --- | --- |
| Live green | `#2fbf71` | The running dot — everywhere, both themes. Never recolor it. |
| Stroke (light) | `#525252` | Mark strokes on light grounds |
| Stroke (dark) | `#d4d4d4` | Mark strokes on dark grounds |
| Queued-card stroke | `#9c9ca3` / `#7c7c82` | Optional depth split (light/dark) on large renders — app icons, banner |
| App-icon ground (dark) | `#18181b → #09090b` | Vertical gradient |
| App-icon ground (light) | `#ffffff → #ececef` | Vertical gradient |

`#2fbf71` is the *brand* live green (it matches the banner). The UI's semantic
success colors (`--success` in `packages/ui/src/styles/theme.css`) are separate
theme tokens — don't conflate them.

## Files

| File | What it is |
| --- | --- |
| `icon.svg` | Canonical mark. Theme-adaptive (`prefers-color-scheme`), favicon-ready. |
| `app-icon-apple-dark.svg` / `-light.svg` | iOS/macOS tile render (512, ~22.4% corner radius baked in for preview). |
| `app-icon-android-dark.svg` / `-light.svg` | Android adaptive-icon render (512 circle, glyph inside the 66/108 safe zone). |
| `banner.html` | Source for the README/docs banner. |
| `banner.png` | Rendered banner, 3200×1040. |

Full platform asset packages (Apple's square 1024 master without the baked
mask, Android foreground/background layers, PNG size ramps) are deliberately
deferred — derive them from these renders when an app ships.

## Where the mark is deployed

- `packages/web/public/favicon.svg` and `apps/docs/public/favicon.svg` — copies of `icon.svg`
- `packages/web/src/components/shell/BrandMark.tsx` — inline mark in the dashboard sidebar
- `apps/docs/src/components/Header.astro` — inline mark in the docs header

Keep all of these byte-identical in geometry to `icon.svg` — the mark has no
per-surface variants besides stroke color (`currentColor` inline, adaptive in
the favicon).

## Regenerating banner.png

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --force-device-scale-factor=2 --window-size=1600,520 \
  --screenshot=docs/assets/banner.png "file://$PWD/docs/assets/banner.html"
```

## Usage rules

- The dot is always `#2fbf71` and always filled — it's the "live" signal, not decoration.
- Strokes may be `currentColor` when inlined; never restyle the geometry.
- Minimum size 16px; below ~20px prefer the plain mark over the app-icon tiles.
- Don't put the mark in a filled chip or recolor it to an accent — the outline + dot *is* the mark.

# WorkerDeck brand

## The mark — "Iso Deck"

A deck of sessions seen in isometric projection: the top face is the session in
front of you, the two edges below it are the ones stacked underneath, and the
green diamond on the top face is the one running *now*. It says the same thing
the product does — many sessions, one you're watching — and unlike a rounded
square with a chevron in it, it owns a silhouette at 16px in a bar full of
other icons.

Geometry lives in a 24×24 viewBox at stroke-width 2 (lucide idiom, so it sits
next to lucide icons in the app):

```svg
<path d="M12 3 20.5 7.75 12 12.5 3.5 7.75Z" />   <!-- top face   -->
<path d="M3.5 12.25 12 17l8.5-4.75" />           <!-- deck below -->
<path d="M3.5 16.5 12 21.25l8.5-4.75" />         <!-- deck below -->
<path d="M12 6.15 14.85 7.75 12 9.35 9.15 7.75Z" fill="#2fbf71" />  <!-- live -->
```

Two numbers hold the whole thing together, and neither is arbitrary:

- **The projection is 1.789** — the top face is 8.5 × 4.75 in half-axes. Every
  plane is 4.25 apart on y, which is what makes the three levels read as one
  solid rather than three drawings.
- **The live marker is 1.781** — 2.85 × 1.60. It is a rhombus rather than a
  circle *because* of that ratio: it lies on the top face's plane instead of
  floating above it, and it survives the shrink to 16px, where a small circle
  reads as an artifact of the stroke.

Only the levels below the top face are ever drawn as edges. That is occlusion,
not style: the face above hides the rest of them. Anything that draws a level
with nothing on top of it — the loading state does — draws the whole rhombus.

On large renders the marker gets a halo, the same rhombus at 1.9×, so the glow
follows the projection too:

```svg
<path d="M12 4.71 17.42 7.75 12 10.79 6.58 7.75Z" fill="#2fbf71" opacity="0.18" />
```

## Color

| Token | Value | Use |
| --- | --- | --- |
| Live green | `#2fbf71` | The live marker — everywhere, both themes. Never recolor it. |
| Stroke (light) | `#525252` | Mark strokes on light grounds |
| Stroke (dark) | `#d4d4d4` | Mark strokes on dark grounds |
| Lower-edge stroke | `#9c9ca3` / `#7c7c82` | Optional depth split (light/dark) on large renders — app icons, banner |
| App-icon ground (dark) | `#18181b → #09090b` | Vertical gradient |
| App-icon ground (light) | `#ffffff → #ececef` | Vertical gradient |

`#2fbf71` is the *brand* live green (it matches the banner). The UI's semantic
success colors (`--success` in `packages/ui/src/styles/theme.css`) are separate
theme tokens — don't conflate them.

## Files

| File | What it is |
| --- | --- |
| `icon.svg` | Canonical mark. Theme-adaptive (`prefers-color-scheme`), favicon-ready. |
| `icon-loading.svg` | The animated mark — see "The loading state" below. Same file, pure CSS, no JS. |
| `app-icon-apple-dark.svg` / `-light.svg` | iOS/macOS tile render (512, ~22.4% corner radius baked in for preview). |
| `app-icon-apple-master.svg` | Square 1024 master, **no** baked mask — what the shipped iOS icon is built from. |
| `app-icon-apple-layer.svg` | Same glyph, transparent ground — feeds the iOS 18 Dark/Tinted appearances. |
| `app-icon-android-dark.svg` / `-light.svg` | Android adaptive-icon render (512 circle, glyph inside the 66/108 safe zone). |
| `banner.html` | Source for the README/docs banner. |
| `banner.png` | Rendered banner, 3200×1040. |
| `claude-code.svg` | **Not ours.** Anthropic's Claude Code mark, in its own colour (`#D97757`). |

`claude-code.svg` is here because a UI that reports a claude.ai plan's limits has
to say whose plan it is: it labels the plan line in the iOS `UsageSheet` (copied
into `ClaudeCode.imageset`) and nothing else. It is not subject to any rule below
— don't recolour it, don't compose it with the WorkerDeck mark, and don't use it
anywhere the product itself is being named.

The remaining platform assets (Android foreground/background layers, PNG size
ramps) are deliberately deferred — derive them from these renders when an app
ships.

## Where the mark is deployed

- `packages/web/public/favicon.svg` and `apps/docs/public/favicon.svg` — copies of `icon.svg`
- `packages/web/src/components/shell/BrandMark.tsx` — inline mark in the dashboard sidebar
- `apps/docs/src/components/Header.astro` — inline mark in the docs header
- `apps/vscode/media/sidebar.svg` — the extension's activity-bar and panel icon
- `apps/ios/App/Assets.xcassets/AppIcon.appiconset` — the iOS app icon (rendered PNGs, checked in)
- `docs/assets/banner.html` → `banner.png` — the mark in the banner's badge

Keep all of these byte-identical in geometry to `icon.svg` — the mark has no
per-surface variants besides stroke color (`currentColor` inline, adaptive in
the favicon).

**The VS Code file is the one that cannot use the green**, and that is a
platform fact rather than a preference: VS Code *masks* view-container icons to
a single theme colour, so a `#2fbf71` marker is silently flattened to whatever
the activity bar's foreground is. It therefore draws the marker in
`currentColor` and lets the silhouette carry the mark. Don't "fix" it by putting
the green back — you would only be writing a colour nobody ever sees.

## Regenerating banner.png

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --force-device-scale-factor=2 --window-size=1600,520 \
  --screenshot=docs/assets/banner.png "file://$PWD/docs/assets/banner.html"
```

## Regenerating the iOS app icon

Three renditions, all 1024: the opaque tile, plus the transparent-ground layer
that iOS 18 uses for the Dark and Tinted home-screen appearances. Alpha is
mandatory on the variants and forbidden on the opaque one (App Store validation
rejects an app icon with an alpha channel), which is what the `-alpha remove`
and `PNG32:` flags are for. Run from the repo root:

```sh
D=apps/ios/App/Assets.xcassets/AppIcon.appiconset
rsvg-convert -w 1024 -h 1024 docs/assets/app-icon-apple-master.svg -o /tmp/icon.png
magick /tmp/icon.png -background black -alpha remove -alpha off PNG24:"$D/icon-1024.png"
rsvg-convert -w 1024 -h 1024 docs/assets/app-icon-apple-layer.svg -o "$D/icon-1024-dark.png"
magick "$D/icon-1024-dark.png" -colorspace Gray -set colorspace sRGB PNG32:"$D/icon-1024-tinted.png"
```

Never round the corners yourself — iOS masks the icon, and the pre-rounded
512 preview tiles would come out double-masked. The catalog is wired through
`apps/ios/project.yml` (`sources` + `ASSETCATALOG_COMPILER_APPICON_NAME`), not
through Xcode's UI: the `.xcodeproj` is generated and any UI edit is lost on the
next `xcodegen generate`.

## The loading state

`icon-loading.svg` is the mark doing something rather than a second drawing: one
layer glides up the deck and the rest assembles behind it, landing on the
complete logo every round.

```
0.0s  the active layer holds at level 1 (lowest)
0.4s  glides to level 2
0.8s  level 1 fades in behind it, as a front edge
1.0s  glides to level 3
1.4s  level 2 fades in  →  the whole mark, held for a second
2.6s  level 1 fades out
2.75s level 2 fades out
2.9s  glides home to level 1
```

Four things about it are load-bearing:

- **The active layer is ONE element that moves.** Not three that blink. It is
  authored at the top-face plane and translated *down*, so `translateY(0)` **is**
  the resting mark — the icon is the origin of the timeline, not a special case
  in it. That is also what makes `prefers-reduced-motion` free: stop the
  animation and you are looking at the logo.
- **The active layer is always the full rhombus**, because it is by definition
  the uncovered top of the stack. What it leaves behind becomes a front edge.
  Same occlusion rule as the static mark, which is why the held beat matches it
  exactly.
- **Two clocks.** The journey is 3.6s; the marker pulses on its own 0.6s, which
  divides evenly into it, so the diamond never lands mid-state at the loop
  boundary. The four states — `⋄` dot, `◇` outline, `◈` semi, `◆` full — are
  built from two shapes (an inner pip and an outer diamond that is either
  stroked or filled), not four.
- **Below ~24px the pulse collapses** into a blink; the *travel* still reads, so
  it degrades to a working spinner rather than to mush. It is not a 16px asset.

The terminal equivalent is the same four states as characters — `⋄ ◇ ◈ ◆` at
150ms — but note that `U+25C6/7/8` are East-Asian **ambiguous width**: safe in a
webview that centres the glyph in a fixed box, capable of rendering double-width
in a terminal under an East-Asian locale and shifting every line with it. Use
the ASCII set there.

## Usage rules

- The live marker is always `#2fbf71` and always filled — it's the "live" signal, not decoration.
- Strokes may be `currentColor` when inlined; never restyle the geometry.
- Minimum size 16px; below ~20px prefer the plain mark over the app-icon tiles.
- Don't put the mark in a filled chip or recolor it to an accent — the deck + marker *is* the mark.
- Only the top-most drawn level shows its whole rhombus. Levels under it are front edges.

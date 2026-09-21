# WorkerDeck brand

## The mark - "Iso Deck"

A deck of sessions seen in isometric projection: the top face is the session in
front of you, the two edges below it are the ones stacked underneath, and the
green diamond on the top face is the one running *now*. It says the same thing
the product does - many sessions, one you're watching - and unlike a rounded
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

- **The projection is 1.789** - the top face is 8.5 × 4.75 in half-axes. Every
  plane is 4.25 apart on y, which is what makes the three levels read as one
  solid rather than three drawings.
- **The live marker is 1.781** - 2.85 × 1.60. It is a rhombus rather than a
  circle *because* of that ratio: it lies on the top face's plane instead of
  floating above it, and it survives the shrink to 16px, where a small circle
  reads as an artifact of the stroke.

Only the levels below the top face are ever drawn as edges. That is occlusion,
not style: the face above hides the rest of them. Anything that draws a level
with nothing on top of it - the loading state does - draws the whole rhombus.

On large renders the marker gets a halo, the same rhombus at 1.9×, so the glow
follows the projection too:

```svg
<path d="M12 4.71 17.42 7.75 12 10.79 6.58 7.75Z" fill="#2fbf71" opacity="0.18" />
```

## Color

| Token | Value | Use |
| --- | --- | --- |
| Primary blue | `#0078d4` | The product's primary - buttons, selection, focus rings, badges. Same hue both themes. |
| Primary blue (dark lift) | `#3794ff` | Hover and focus ring on dark grounds only; too light to carry white text. |
| Live green | `#2fbf71` | The live marker - everywhere, both themes. Never recolor it. |
| Stroke (light) | `#525252` | Mark strokes on light grounds |
| Stroke (dark) | `#d4d4d4` | Mark strokes on dark grounds |
| Lower-edge stroke | `#9c9ca3` / `#7c7c82` | Optional depth split (light/dark) on large renders - app icons, banner |
| App-icon ground (dark) | `#18181b → #09090b` | Vertical gradient |
| App-icon ground (light) | `#ffffff → #ececef` | Vertical gradient |

`#2fbf71` is the *brand* live green (it matches the banner). The UI's semantic
success colors (`--success` in `packages/ui/src/styles/theme.css`) are separate
theme tokens - don't conflate them.

The blue and the green answer different questions and must not be merged. The
**blue is the primary**: it says "this is the thing to press, this is what is
selected". The **green is a signal**: it says "this is live, right now". A
primary that also meant "live" would have nothing left to say when a session
started running - which is why the mark keeps its green diamond even though the
product's primary is now blue. `--accent` in
`packages/ui/src/styles/theme.css` is the blue; iOS carries it as the
`AccentColor` asset; the VS Code webviews deliberately override it with
`--vscode-*` theme colors, because a panel inside an editor follows the
editor's theme rather than ours.

## Files

| File | What it is |
| --- | --- |
| `icon.svg` | Canonical mark. Theme-adaptive (`prefers-color-scheme`), favicon-ready. |
| `icon-loading.svg` | The animated mark - see "The loading state" below. Same file, pure CSS, no JS. |
| `icon.png` | The mark rasterised, 192px, for consumers that cannot render SVG. |
| `app-icon-apple-dark.svg` / `-light.svg` | iOS/macOS tile render (512, ~22.4% corner radius baked in for preview). |
| `app-icon-apple-master.svg` | Square 1024 master, **no** baked mask - what the shipped iOS icon is built from. |
| `app-icon-apple-layer.svg` | Same glyph, transparent ground - feeds the iOS 18 Dark/Tinted appearances. |
| `app-icon-android-dark.svg` / `-light.svg` | Android adaptive-icon render (512 circle, glyph inside the 66/108 safe zone). |
| `banner.html` | Source for the README/docs banner. |
| `banner.png` | Rendered banner, 3200×1040. |
| `card-{web,ios,vscode,embedded,server}.html` | Sources for the README "One server, four ways in" showcase cards. |
| `card-{web,ios,vscode,embedded}.png` | Rendered client cards, 1600×1000 (shown ~230px wide - see the regen section). |
| `card-server.png` | Rendered server slab, 2400×560, full README width. |
| `screenshot-web.png` | The README's product shot - a real dashboard session, 2880×1520. |
| `claude-code.svg` | **Not ours.** Anthropic's Claude Code mark, in its own colour (`#D97757`). |

`claude-code.svg` is here because a UI that reports a claude.ai plan's limits has
to say whose plan it is: it labels the plan line in the iOS `UsageSheet` (copied
into `ClaudeCode.imageset`) and nothing else. It is not subject to any rule below
- don't recolour it, don't compose it with the WorkerDeck mark, and don't use it
anywhere the product itself is being named.

The remaining platform assets (Android foreground/background layers, PNG size
ramps) are deliberately deferred - derive them from these renders when an app
ships.

## Where the mark is deployed

- `packages/web/public/favicon.svg` and `apps/docs/public/favicon.svg` - copies of `icon.svg`
- `packages/web/src/components/shell/BrandMark.tsx` - inline mark in the dashboard sidebar
- `apps/docs/src/components/Header.astro` - inline mark in the docs header
- `apps/vscode/media/sidebar.svg` - the extension's activity-bar and panel icon
- `apps/ios/App/Assets.xcassets/AppIcon.appiconset` - the iOS app icon (rendered PNGs, checked in)
- `docs/assets/banner.html` → `banner.png` - the mark in the banner's badge
- `docs/assets/card-server.html` → `card-server.png` - the mark on the README's server slab
- `apps/docs/public/og.png` - **a copy of `banner.png`**, and the docs site's social card. It is
  a copy rather than a build step because Astro serves `public/` verbatim and the banner lives
  outside the app; re-copy it whenever the banner is re-rendered, or shared links will show the
  old tagline long after the README stops.

Keep all of these byte-identical in geometry to `icon.svg` - the mark has no
per-surface variants besides stroke color (`currentColor` inline, adaptive in
the favicon).

**The VS Code file is the one that cannot use the green**, and that is a
platform fact rather than a preference: VS Code *masks* view-container icons to
a single theme colour, so a `#2fbf71` marker is silently flattened to whatever
the activity bar's foreground is. It therefore draws the marker in
`currentColor` and lets the silhouette carry the mark. Don't "fix" it by putting
the green back - you would only be writing a colour nobody ever sees.

## Regenerating icon.png

`icon.png` exists because **Apple cannot decode an SVG from bytes** - ImageIO
lists 62 image types and none of them is SVG, and asset catalogs convert at
*compile* time, which a file downloaded at runtime cannot use. The iOS app is
the consumer: this repo's own `.workerdeck.json` declares an icon, and the phone
would otherwise show none.

Two deliberate differences from `icon.svg`:

- **The `prefers-color-scheme` block is dropped**, because a raster cannot
  adapt. Leaving it in the source would make the file look like it still does.
- **One stroke tone for both grounds.** `#787878` was chosen by measuring
  contrast rather than by eye: it lands at 4.02:1 on the dark ground (`#181818`)
  and 4.16:1 on the light one (`#f8f8f8`), the best available balance and above
  the 3:1 WCAG threshold for a graphical object either way. The adaptive SVG
  scores better on each (7.4 and 12.0) - that is simply what a single tone
  costs, and the mark is decoration beside a name it does not have to carry.

The green accent (`#2fbf71`) is untouched: it has `stroke="none"` and reads on
both grounds already.

```sh
sed 's|stroke="#525252"|stroke="#787878"|' icon.svg \
  | perl -0pe 's|<style>.*?</style>||s' > /tmp/icon-flat.svg
rsvg-convert -w 192 -h 192 -o icon.png /tmp/icon-flat.svg
```

Keep the geometry byte-identical to `icon.svg` - the rule below applies here too.

## Regenerating banner.png

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --force-device-scale-factor=2 --window-size=1600,520 \
  --screenshot=docs/assets/banner.png "file://$PWD/docs/assets/banner.html"
```

## The wordmark

**`WorkerDeck`** - one word, two capitals, wherever the name is set as text: the docs site
header, the README, a card. The banner's badge is the one deliberate exception, and it is a
*badge* treatment rather than the wordmark: letterspaced mono uppercase (`WORKERDECK`), which
reads as a label beside the mark rather than as the name itself. Lowercase `workerdeck` belongs
only where it is literally an identifier - the npm package, a command, a URL.

## Regenerating the README showcase cards

Same recipe as the banner, one run per card. The four client cards are authored at
800×500 and the server slab at 1200×280, both rendered at 2x:

```sh
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for c in web ios vscode embedded; do
  "$C" --headless=new --disable-gpu --force-device-scale-factor=2 --window-size=800,500 \
    --screenshot=docs/assets/card-$c.png "file://$PWD/docs/assets/card-$c.html"
done
"$C" --headless=new --disable-gpu --force-device-scale-factor=2 --window-size=1200,280 \
  --screenshot=docs/assets/card-server.png "file://$PWD/docs/assets/card-server.html"
```

The constraint that shaped them: in the README's 4-column table each client card
renders ~230px wide, so the art is skeleton bars and silhouettes - few elements,
one idea per card, and the only real words are the ones that survive the shrink
("Allow"/"Deny", the panel tab, the package names on the slab, which renders near
full width). Squint-test any change at ~230px before shipping it. Each card carries
exactly one `#2fbf71` live signal (on the server slab it is the mark's own diamond);
the VS Code card draws the mark monochrome because VS Code itself masks
view-container icons to one colour (see "Where the mark is deployed").

## Regenerating the product screenshot

`screenshot-web.png` is the one asset here that is **not** a drawing. It is a real session
captured from the running dashboard, and that is the whole point of it - the cards sell the
shape of the product, this sells that the product exists. Re-shoot it whenever the session
surface changes enough that the old frame misrepresents it.

The recipe, in order, because each step is there for a reason:

1. `pnpm dev:server` and `pnpm dev:web`, then open `http://localhost:5191/`.
2. Size the window to **1440×760**. Width is the usual laptop frame; the short height is
   deliberate - the transcript pane is flexible and the permission panel is pinned to the
   bottom, so a tall window puts a band of dead space between them.
3. Hide the file tree (the rail's own toggle). It is a real feature, but at README width its
   `node_modules` and dotfiles are the most legible thing in the frame, which is the wrong thing
   to draw the eye.
4. Start a session on a real repo with a prompt whose *answer* is short enough to read at a
   glance, then a follow-up that makes the agent propose a **file edit** - the diff plus the
   approve/deny prompt is the product's actual claim, and a shot without one is just a chat log.
5. Capture while the approval is pending, at 2× device scale. Then answer the prompt and revert
   whatever the agent changed; the shot is marketing, not a commit.

What has to be true of the frame before it ships: no other project's secrets in the session
list, a cost and usage line you are willing to publish, and a diff whose content is boring.

`apps/docs/public/screenshot-web.png` is **a copy of this file**, for the same reason `og.png`
is a copy of the banner: Astro serves `public/` verbatim and the asset lives outside the app.
Re-copy it whenever you re-shoot.

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

Never round the corners yourself - iOS masks the icon, and the pre-rounded
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
  the resting mark - the icon is the origin of the timeline, not a special case
  in it. That is also what makes `prefers-reduced-motion` free: stop the
  animation and you are looking at the logo.
- **The active layer is always the full rhombus**, because it is by definition
  the uncovered top of the stack. What it leaves behind becomes a front edge.
  Same occlusion rule as the static mark, which is why the held beat matches it
  exactly.
- **Two clocks.** The journey is 3.6s; the marker pulses on its own 0.6s, which
  divides evenly into it, so the diamond never lands mid-state at the loop
  boundary. The four states - `⋄` dot, `◇` outline, `◈` semi, `◆` full - are
  built from two shapes (an inner pip and an outer diamond that is either
  stroked or filled), not four.
- **Below ~24px the pulse collapses** into a blink; the *travel* still reads, so
  it degrades to a working spinner rather than to mush. It is not a 16px asset.

**The terminal transcript no longer mirrors this.** It used to spell the same
four states as characters, which made the marker and the mark one animation; it
now runs the classic braille spinner on its own clock, so the asset here has no
twin in the product's text. Nothing about the asset changed, and the rule the
old pairing taught survives it: those glyph blocks are East-Asian **ambiguous
width**, safe only where something centres them in a fixed box. The caveat lives
in `docs/GOTCHAS.md` § Terminal theme now, with the marker it belongs to.

## Usage rules

- The live marker is always `#2fbf71` and always filled - it's the "live" signal, not decoration.
- Strokes may be `currentColor` when inlined; never restyle the geometry.
- Minimum size 16px; below ~20px prefer the plain mark over the app-icon tiles.
- Don't put the mark in a filled chip or recolor it to an accent - the deck + marker *is* the mark.
- Only the top-most drawn level shows its whole rhombus. Levels under it are front edges.

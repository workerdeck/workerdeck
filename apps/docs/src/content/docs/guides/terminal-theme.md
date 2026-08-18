---
title: The terminal theme
description: The transcript drawn the way the CLI draws it — a character grid, no boxes, diffs as full-width bands — and the three knobs an embedder gets.
order: 9
---

`SessionPanel` draws a turn one of two ways. `cards` is the chat convention: bubbles, bordered
tool cards, generous gaps — right for a wide dashboard where the transcript is the page.
`terminal` is the other one, and it is what the Claude Code CLI actually looks like.

```tsx
<SessionPanel
  client={client}
  sessionId={sessionId}
  transcriptVariant='terminal'
/>
```

That is the whole opt-in. Everything below is optional.

## What it is

Not a restyled card. `terminal` is a **separate renderer** (`components/terminal/`) that the panel
mounts *instead of* the card components, so nothing in the card path has a terminal branch in it.
Two rules hold the rendering up:

1. **Horizontal measures are `ch`.** One `ch` in a monospace face is exactly one cell, so a gutter
   is `2ch` and an indent level is `2ch`, and text lands *on* a column rather than near one. A
   wrapped line hangs under its own first character because the body is its own grid column — not
   because a padding and a negative text-indent were tuned against each other.
2. **Vertical measures are whole multiples of one line.** The space between blocks is a *blank
   line*, the way it is in a terminal. Nothing has margins, so no two blocks can disagree about the
   rhythm.

Everything is built from three primitives — a row (gutter cell + body cell), a blank line, and a
full-bleed band — and the palette is the terminal's own (`--term-*`), not the app's. Re-theme the
surrounding application and the transcript still looks like the CLI, which is the point.

Markdown goes through the renderer's own component map, and a diff renders protocol's `FilePatch`
with **the engine's** line numbers: this code has never read the file, so a number it computed
would look authoritative and point at the wrong line.

## The character cell

`terminalMetrics` sets the cell, in **whole pixels**:

```tsx
<SessionPanel
  transcriptVariant='terminal'
  terminalMetrics={{ fontSize: 13, lineHeight: 18 }}   // the CLI's own, and the default
/>
```

Whole pixels is not a nicety. A line height of `1.5 × 13px` is 19.5px, and every second row of a
long transcript then renders on a half-pixel: the text visibly softens and the diff bands show a
seam along their edge. `TerminalSurface` rounds what it is handed for exactly this reason.

One prop rather than two per surface, because the panel mounts **three** terminal surfaces — the
transcript, the pending approval/question prompts, and the composer — each in a different part of
its flex column. Hand two of them different numbers and the caret lands on a different column from
the text above it, which is the one failure this theme exists to prevent.

The VS Code extension follows `editor.fontSize` / `editor.lineHeight` here, so the panel, the
editor and the integrated terminal all draw at one size.

## Affordances

A terminal cannot highlight the row under your cursor and cannot put a copy button on a block of
output. A web view can do both for free, and they are genuinely useful — so both are **on** by
default:

```tsx
<SessionPanel transcriptVariant='terminal' affordances={false} />   {/* the pure article */}
<SessionPanel transcriptVariant='terminal' affordances={{ hover: true, actions: false }} />
```

The rule that keeps this honest is that **each one costs no layout**. The hover fill is a
background; an action button is an overlay one line tall, absolutely positioned so it displaces
nothing. Turn them all off and every glyph is on exactly the same cell it was on — which is what
makes `false` a real option rather than a degraded mode, and why a new affordance may not be added
as anything that occupies space.

## What it changes elsewhere in the panel

- **The composer** becomes the CLI's prompt: `>` in the gutter cell every transcript row's marker
  sits in, so what you type starts on the column what you are reading starts on. Docked flush to
  the panel edges — no radius, no shadow — with one rule along the top that turns accent while
  anything inside has focus, and `+` / `↵` characters in place of the round pills.
- **Approvals and questions** are keyboard-first rows rather than dialogs: one question at a time
  behind a chip strip, ending in a review step, answerable entirely from `↑↓`, the digits and
  `esc`. No boxes means the affordance has to be carried by the keyboard, which is what a terminal
  does anyway.
- **`transcriptDensity` and `transcriptFont` stop meaning anything.** A terminal has one line
  height and is monospace by construction. Both are inert rather than broken under `terminal` — a
  host that offers them as settings should say so, or hide them. (The dashboard hides them; the VS
  Code extension documents them as Cards-only.)

## Where it is already on

The VS Code extension's dock defaults to it (`workerdeck.transcriptVariant`), the dashboard offers
it as **Agent view style → Terminal** in Settings, and the reference embedding
(`apps/embedded`) runs it in a 26rem rail — the densest thing there is.

The **iOS app** has it too, as **Settings → Style → Terminal**, but it shares no code with the
above: it is a native Swift renderer over a Swift port of the same rules (the two folds, the
cell/wrap model, the strings that are the heights). One thing is deliberately inverted there and
worth knowing if you are porting this yourself — on the web the browser wraps and the calculator
*predicts* how many lines that will be, while on iOS the planner wraps and the renderer draws the
lines it returned, so a row's height is exact by construction rather than by a prediction that is
99% right. If you own the renderer, that is the better trade, and it costs nothing: the wrap was
computed to measure the row anyway.

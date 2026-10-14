# Native core snapshots

What `crates/core/src/snapshot.rs` hands a native renderer, through `crates/ffi` (UniFFI, lib
`wdffi`). Commands, effects and state go through UniFFI records; everything a renderer draws is
one of these byte buffers, so a redraw costs one crossing.

Little-endian. Every buffer opens with `u8 version` (currently **4**, `snapshot_version()`); a
reader that sees another version refuses the buffer. `str16` / `str32` are a `u16` / `u32` byte
length and UTF-8 bytes (`str16` is cut at a character boundary).

## Transcript layout (`transcript_layout`, `frame_layout`)

```
u8 version
u32 rowCount
rowCount x { str16 key, f32 height, u8 flags (1 gapAbove, 2 prompt, 4 recap) }
i32 revealRow (-1: none), u64 revealNonce
```

`height` already includes the gap line above a row. Keys are stable across updates: diff the list
by key.

## Transcript lines (`transcript_lines`, `frame_lines`, `prompt_plan_lines`)

```
u8 version
u32 startRow, u32 rowCount
rowCount x { u32 lineCount, lineCount x line }
line = u8 tone, u8 gutterTone, u8 band, u8 flags,
       u16 indent, u16 columns, str16 gutter, str32 text,
       u16 runCount, runCount x { u32 byteStart, u32 byteLen, u8 intent },
       [f64 elapsedSince]                       if flags & 0x80
       [str16 toolUseId, i64 sourceSeq, i64 partIndex,
        str16 mediaType, i64 bytes, u16 lines,
        str16 name, str16 placeholder,
        str16 hostPath]                         if flags & 0x40
```

An image line opens a box `lines` tall (the following lines are blank); fetch its bytes at
`result_image_path(sessionId, sourceSeq, toolUseId, partIndex)` under the API base. `name` titles the
viewer, `placeholder` (`image · 12 KB`) fills the box until the bytes land, `image_unavailable()` after a failure.
A non-empty `hostPath` is a codex picture named by its path on the host (`CodexImageGeneration`,
`CodexImageView`): fetch `Session.host_image_path(sessionId, hostPath)` instead, a produced file when the
session announced one and `/fs/read` otherwise; `host_image_base64(body, hostPath)` reads the latter's answer.

`prompt_plan_lines` is the same shape with one row at 0: a plan prompt's markdown, planned at the session's metrics.

Flags: 1 bold, 2 italic, 4 nested, 8 pulsing, 16 inOpen, 32 pressable, 64 image, 128 elapsed.
Tone and band index `tone_names()` / `band_names()` (the `planner::Tone` / `planner::Band`
declaration order); key a palette on those names. Run `intent` is a bit set from
`markdown.rs`: 1 em, 2 strong, 4 code, 32 strike. A pressable line is
answered with `press_line(row, line)` (`frame_press_line` in a frame): the core re-plans the row to
recover the press, so no press value ever crosses the boundary.

`transcript_frame(start, end)` is a layout buffer immediately followed by a lines buffer.

## Shell grid (`shell_grid`)

```
u8 version
u64 revision
u16 cols, u16 rows, u32 totalLines (scrollback + screen)
u16 cursorRow, u16 cursorCol
u8 flags (1 cursorVisible, 2 altScreen, 4 canType, 8 running, 16 ended)
str16 title, str16 statusText
u32 startLine, u32 lineCount
lineCount x { u16 runCount, runCount x { u32 fg, u32 bg, u8 style, u16 columns, str32 text } }
```

`startLine` counts from the oldest scrollback line; the live screen is the last `rows` lines.
Colors arrive resolved (version 2): `0` the slot's default (the theme foreground for `fg`, no fill
for `bg`), `0x01000000` the theme foreground, `0x03000000` the theme background, `0x02000000 | rgb`.
The core maps the 256-colour palette to RGB and applies inverse (an unset colour swaps in the theme's
own), so a renderer maps four words onto its palette and never reads the style for colour. Style bits:
1 bold, 2 dim, 4 italic, 8 underline, 16 inverse (already applied), 32 strikethrough, 64 hidden.
`columns` is the run's width in cells: a wide character is one run character in two columns, so a
renderer advances by `columns`, never by the text's length.

## Calling pattern

One `Session` per open session, driven from one thread. Every mutating call returns the effects
it caused (`take_effects` exists for completeness). Batch frames that arrive together with
`received_batch` (newline-separated): one UniFFI call costs 8 to 20 us on the emulator, so an
attach replay of 50k frames must not cross once per frame. Redraw on `Changed`.

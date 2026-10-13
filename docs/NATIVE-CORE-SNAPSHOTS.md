# Native core snapshots

What `crates/core/src/snapshot.rs` hands a native renderer, through `crates/ffi` (UniFFI, lib
`wdffi`). Commands, effects and state go through UniFFI records; everything a renderer draws is
one of these byte buffers, so a redraw costs one crossing.

Little-endian. Every buffer opens with `u8 version` (currently **1**, `snapshot_version()`); a
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

## Transcript lines (`transcript_lines`, `frame_lines`)

```
u8 version
u32 startRow, u32 rowCount
rowCount x { u32 lineCount, lineCount x line }
line = u8 tone, u8 gutterTone, u8 band, u8 flags,
       u16 indent, u16 columns, str16 gutter, str32 text,
       u16 runCount, runCount x { u32 byteStart, u32 byteLen, u8 intent },
       [f64 elapsedSince]                       if flags & 0x80
       [str16 toolUseId, i64 sourceSeq, i64 partIndex,
        str16 mediaType, i64 bytes, u16 lines]  if flags & 0x40
```

Flags: 1 bold, 2 italic, 4 nested, 8 pulsing, 16 inOpen, 32 pressable, 64 image, 128 elapsed.
Tone and band are the `planner::Tone` / `planner::Band` declaration order. A pressable line is
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
lineCount x { u16 runCount, runCount x { u32 fg, u32 bg, u8 style, str32 text } }
```

`startLine` counts from the oldest scrollback line; the live screen is the last `rows` lines.
Colors: `0` default, `0x01000000 | index`, `0x02000000 | rgb`. Style bits: 1 bold, 2 dim, 4 italic,
8 underline, 16 inverse, 32 strikethrough, 64 hidden. Wide characters occupy one run character and
two columns (continuation cells are skipped).

## Calling pattern

One `Session` per open session, driven from one thread. Every mutating call returns the effects
it caused (`take_effects` exists for completeness). Batch frames that arrive together with
`received_batch` (newline-separated): one UniFFI call costs 8 to 20 us on the emulator, so an
attach replay of 50k frames must not cross once per frame. Redraw on `Changed`.

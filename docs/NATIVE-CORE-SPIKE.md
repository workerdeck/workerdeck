# Native core spike (2026-10-12)

The record of why the native clients share a **Rust** core rather than the Swift kit. The spike
code itself stayed local; what survived it is `crates/` (`docs/PACKAGES.md` § `crates/`).

## Question

Should the Android app (Kotlin + Compose) share its core with iOS, and in which language? Two
arms, one workload, measured on the same emulator behind the same JNI surface and Compose screen:

- **Swift arm**: the existing `apps/ios/WorkerDeckKit` sources, cross-compiled with the Swift SDK
  for Android (Swift 6.4.0), called over hand-written JNI (`@_cdecl`).
- **Rust arm**: a port of the code paths the fixture exercises (decode, `applyEvent`, rows,
  planner, height book, VT screen), called over the `jni` crate.

Networking was out of scope: it stays native (OkHttp / URLSession) whatever the core is.

## Workload

Synthetic and deterministic (`crates/bench/fixtures/gen.mjs`, never real transcripts): 53,563
`ServerFrame` lines over 80 turns (52,592 text deltas of 2 to 7 characters, thinking, markdown,
Read/Bash/Grep/Edit calls with results of up to 260 lines), and 238 KB of PTY output (SGR
16/256/truecolor, progress bars with `\r` + `EL`, cursor save/restore, wide and combining
characters, emoji).

| Key | What |
| --- | --- |
| `w1_replay_ms` | decode + fold every frame except the last 2000 (an attach replay) |
| `w2_cold_layout_ms` | rows build + height book over the replayed transcript (first paint) |
| `w3_stream_us` | per frame for the last 2000: decode, fold, rows, book, plan and encode the last 60 visible lines |
| `w3_ingest_us` | the decode + fold part of the above |
| `w4_vt_mb_per_s` | the PTY text fed 10 times in 4096-scalar chunks into a 120x40 screen, 1000 lines of scrollback |
| `w4_vt_snapshot_us` | encode the visible VT grid as styled runs |

## Results

Emulator (Pixel 7 profile, API 36, arm64) on an Apple Silicon Mac, so arm64 runs natively and
absolute numbers are near desktop speed; a mid-range phone is likely 3 to 5 times slower. The
ratios are what carry over. Median of 3 runs.

| Metric | Swift (kit) | Rust (port) | Ratio |
| --- | --- | --- | --- |
| w1 replay, 51.5k frames | 3304 ms | 136 ms | 24x |
| w2 cold layout | 38 ms | 7.9 ms | 5x |
| w3 streamed delta, p50 / p99 | 2027 / 2754 us | 134 / 1511 us | 15x / 1.8x |
| w3 decode + fold only, p50 | 64 us | 3.3 us | 19x |
| w4 VT throughput | 11.3 MB/s | 72 MB/s | 6x |
| w4 VT snapshot, p50 | 100 us | 21 us | 5x |
| Live stream through JNI + Kotlin, p50 per frame | 2479 us | 165 us | 15x |
| Native library, stripped | 55.8 MB | 0.71 MB | 78x |
| APK on disk / zipped | 58.6 / 22.9 MB | 2.2 / 1.1 MB | 21x |
| `System.loadLibrary` | 9 to 21 ms | 0.5 to 2.4 ms | |
| Cold start (`am start -W`) | 264 to 511 ms | 131 to 242 ms | |

On the Mac: Swift replay 1555 ms, delta p50 2.8 ms; Rust 98 to 125 ms and 0.12 ms. The TypeScript
reducer on V8 replays the same fixture in 72 ms, which is why the web, VS Code, the gateway and the
relay stay TypeScript.

**Output parity**: after a full replay both arms plan the same 7766 lines; 12 differ, all on the
Mac only, where Apple's markdown parser keeps an unclosed `**` that the portable parser drops. The
VT dumps (1040 lines) are identical.

## Where the time goes

Per streamed delta on the Mac. Swift: planning 1913 us, height book 567 us, rows 292 us, decode +
fold 57 us. Rust: planning 42 us, rows 45 us, book 25 us, decode + fold 3 us. The planner's
`String`/`Character`/`AttributedString` work and `JSONDecoder` are where Swift loses.

Part of the replay gap is structural: Swift's `applyEvent` returns a new state and copies the
items array per event. Forcing the same copy in Rust brought its replay to 243 ms against Swift's
1555 ms, so language and library still account for most of it.

## Reading it fairly

- The Rust port covered only what the fixture exercises (about 4.6k lines); a full port is more,
  estimated 10 to 12k lines for the kit minus networking. Paths neither arm ran do not bias the
  numbers.
- The Swift arm was the mature kit with its full test suite; the Rust port had only the dump
  cross-check against it.
- The terminal view janked the same in both arms (p99 around 45 to 50 ms): that is Compose drawing
  40 `Text` rows of spans, not the core. A production terminal view draws on a `Canvas`.

## What the Swift arm needed to build for Android

1. `MarkdownInline`: `AttributedString(markdown:)` is Apple-only, so a small portable inline parser
   stood in off Darwin.
2. `VTScreen` is `@MainActor`; an Android core runs off the UI thread, so the annotation had to go.
3. `WorkerClient` and `SessionHandle` were excluded (URLSession).

Everything else, about 14k lines, compiled for Android unchanged on the first try. The size came
from full `Foundation`: 37 MB of ICU data. An Essentials-only build floors at 11.3 MB stripped,
4.3 MB zipped, but would need about 300 source fixes (`CGFloat`, `NSRegularExpression`,
`String(format:)`, `CharacterSet`, `NSLock` and so on).

## Findings that hold whatever the language

1. Most of the per-delta cost is re-planning the visible tail on every delta. A plan cache per row
   (the height book already caches line counts) removes most of it in either language.
2. The iOS app pays the same Swift costs: the 2 to 3 s session open on a phone measured by
   `AttachReplayBenchTests` matches the replay numbers here, so a Rust core speeds up iOS too.
3. The reducers already disagreed: on this fixture the TypeScript reducer ends with 730 items, the
   Swift kit and the Rust port with 705. Conformance has to be defined before more is ported.

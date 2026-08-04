# WorkerDeck for iOS

Native iOS remote control for a self-hosted [WorkerDeck](../../README.md) server: watch and
drive Claude Code sessions from your phone — streaming transcript, permission prompts, session
creation/resume, context + rate-limit HUD — over your own network (typically Tailscale). No
relay, no cloud: the app is a plain HTTP/WS client to the gateway you already run.

Plan and research: `_docs/plans/mobile-client.md` (gitignored, local).

## Layout

- `WorkerDeckKit/` — SwiftPM package, the platform-agnostic core (builds on iOS + macOS, unit
  tests run with plain `swift test` on a Mac):
  - `ProtocolTypes.swift` / `RestTypes.swift` / `JSONValue.swift` — hand-written Swift mirror of
    `@workerdeck/protocol` (see `WorkerProtocol.version`, kept in lockstep with
    `PROTOCOL_VERSION`). Decoding is lenient by contract: unknown event/frame/block types degrade
    to `.unknown`, never a stream error.
  - `WorkerClient.swift` / `SessionHandle.swift` — REST client + WebSocket session handle
    (attach/replay via `afterSeq`, reconnect with backoff, command outbox). Auth is
    `Authorization: Bearer <key>` on both REST and the WS handshake — native apps don't need the
    cookie machinery the web dashboard uses.
  - `Transcript.swift` — pure transcript reducer, a 1:1 port of
    `packages/react/src/transcript.ts`. Keep the two in sync when transcript semantics change.
  - `MarkdownBlocks.swift` — splits assistant text into prose and fenced code blocks, tolerating
    the unterminated fence that streaming produces. Pure, so it lives here (this package is the
    only part of the app under test); the SwiftUI rendering stays in `App/`.
- `App/` — the SwiftUI app (hosts, sessions, transcript, permissions, HUD). Hosts + auth keys
  are stored in the Keychain.
- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec; the `.xcodeproj` is
  generated, not checked in.

## Building

```sh
# Kit tests (no Xcode project needed)
cd apps/ios/WorkerDeckKit && swift test

# App
cd apps/ios && xcodegen generate && open WorkerDeckApp.xcodeproj
# or headless:
xcodebuild -project WorkerDeckApp.xcodeproj -scheme WorkerDeckApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

The app target needs Xcode's **iOS platform** installed (`xcodebuild -downloadPlatform iOS`, or
Xcode → Settings → Components). Without it `xcodebuild` reports *"iOS <version> is not installed"*
and offers no simulator destinations at all — even though `xcodebuild -showsdks` lists the SDK.

Point the app at your server's base URL (e.g. `http://your-mac.tailnet-name.ts.net:8787`) and
paste the `--auth-key`. The app talks to `<base>/v1`. Plain-`http` hosts on a tailnet are
allowed via an ATS exception in the app — tighten this if you ever distribute beyond personal
use.

## Protocol lockstep

This app speaks the wire protocol directly (it replaces `packages/client` + `react` + `web` on
mobile). When `packages/protocol` changes:

1. Bump-check: the app warns when `AttachedFrame.protocolVersion` ≠ `WorkerProtocol.version`.
2. Mirror the type change in `ProtocolTypes.swift`/`RestTypes.swift` and update
   `WorkerProtocol.version`.
3. If transcript semantics changed, port the `transcript.ts` diff into `Transcript.swift`.

Not yet mirrored (later phases): the job-queue REST/WS surface, profile create/update/delete,
browser-bridge tool hosting (the app answers `tool_call_request` with a polite refusal).

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
  - `App/Assets.xcassets/AppIcon.appiconset` — the app icon, three 1024 renditions (opaque,
    plus the transparent-ground Dark and Tinted appearances iOS 18 asks for). The PNGs are
    generated from `docs/assets/app-icon-apple-{master,layer}.svg`; regenerate with the command
    in `docs/assets/BRAND.md` §"Regenerating the iOS app icon" rather than editing them.
  - `App/Sources/Push/` — remote notifications, which exist because iOS will not hold a WebSocket
    open in the background: the WS is for while you're looking at the screen, APNs is the resume
    signal for every other moment. The token is registered **per gateway** (`POST /apns/devices`
    on the server's own origin, behind the same auth key), tagged with the app's own `hostId` so
    a push can say which server sent it, and with the APNs environment read out of the embedded
    provisioning profile rather than guessed from `#if DEBUG` — see `docs/GOTCHAS.md` §APNs for
    why that distinction is expensive to get wrong. A `permission_requested` push carries
    Approve/Deny actions that answer over REST without opening the app; tapping the body deep-links
    to the session. A gateway with no forwarder configured answers 404 and the app stops asking.
- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec; the `.xcodeproj` is
  generated, not checked in. So are `Info.plist` and `WorkerDeckApp.entitlements` — declare
  capabilities here, because Xcode's "+ Capability" button edits the generated project and is
  erased by the next `xcodegen generate`. `aps-environment` stays `development` in the file:
  that is what an Xcode build needs, and Xcode rewrites it on export for TestFlight.

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

## Push on the Simulator

The Simulator has no APNs connection — `deviceToken` is nil there forever — but `simctl push`
injects a payload locally, which is enough to check the part that is easy to get wrong: that the
category identifier matches and the Approve/Deny actions actually appear. Install the app, launch
it once and tap **Allow** on the notification prompt, then:

```sh
cat > /tmp/perm.json <<'JSON'
{
  "aps": {
    "alert": { "title": "Approval needed — my-repo", "body": "Bash · pnpm test --filter content-gate" },
    "sound": "default",
    "category": "PERMISSION_REQUEST",
    "thread-id": "sess_demo"
  },
  "type": "permission_requested",
  "sessionId": "sess_demo",
  "seq": 42,
  "hostId": "host_demo",
  "requestId": "req_demo"
}
JSON
xcrun simctl push booted bi.atomic.workerdeck.ios /tmp/perm.json
```

**Long-press the banner.** Swiping it only ever offers "Open" — the Approve/Deny buttons live
under the expanded notification, and mistaking that for a missing category is the trap here. The
payload above is the shape `buildPush` emits (`packages/cli/src/apns/forwarder.ts`); keep it in
step with that function, and with `PushCategory` in `App/Sources/Push/PushPayload.swift`.

Approve/Deny answer over REST, so on the Simulator they will fail against `host_demo` — what this
proves is the notification surface, not the round trip. The round trip needs a real device against
the sandbox gateway.

## Protocol lockstep

This app speaks the wire protocol directly (it replaces `packages/client` + `react` + `web` on
mobile). When `packages/protocol` changes:

1. Bump-check: the app warns when `AttachedFrame.protocolVersion` ≠ `WorkerProtocol.version`.
2. Mirror the type change in `ProtocolTypes.swift`/`RestTypes.swift` and update
   `WorkerProtocol.version`.
3. If transcript semantics changed, port the `transcript.ts` diff into `Transcript.swift`.

Not yet mirrored (later phases): the job-queue REST/WS surface, profile create/update/delete,
browser-bridge tool hosting (the app answers `tool_call_request` with a polite refusal).

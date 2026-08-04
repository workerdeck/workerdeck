# WorkerDeck for iOS

Native iOS remote control for a self-hosted [WorkerDeck](../../README.md) server: watch and
drive Claude Code sessions from your phone — streaming transcript, permission prompts, session
creation/resume, context + rate-limit HUD, and a browser/editor for the host's project tree —
over your own network (typically Tailscale). No relay, no cloud: the app is a plain HTTP/WS
client to the gateway you already run.

Plan and research: `_docs/plans/MOBILE-CLIENT.md` (gitignored, local).

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
  - `PromptToken.swift` — the `@file` and `/command` rules in one place: which words are tokens,
    which are being typed, which are finished, and how one is replaced. Here for the same reason
    as `MarkdownBlocks` — pure string logic whose interesting cases are all edges — and shared, so
    a token looks the same in the composer as it does once sent. Both need a word boundary and
    nothing more — so `toby@example.com` isn't a file picker, and a command completes mid-draft
    as well as at the front (the CLI only *runs* one from the front, but the picker is an editing
    aid). What keeps an absolute path from reading as a command is the charset: a command name
    may not contain a slash.
- `App/` — the SwiftUI app (hosts, sessions, transcript, permissions, HUD). Hosts + auth keys
  are stored in the Keychain.
  - `App/Sources/Session/SessionStatusBar.swift` — the mini status bar, one glass line floating
    just above the composer where a thumb reaches it: status, model, permission mode, usage. The
    status slot is **shared with connectivity, and connectivity wins it** — while the socket is
    down the session status the app holds is stale, so "Reconnecting…"/"Offline" replaces it
    rather than sitting beside it. (The handle retries forever; "Offline" is the app's judgement
    after three failed attempts, not a state the handle reports.) Model and permission mode are
    chips that open their own menus — the two settings worth changing mid-run, so they are not in
    the toolbar. Usage is per-window presence, not a mode flag: a radial gauge for each rate-limit
    window the session reports — session, weekly, then whichever per-model window it has — and the
    session's `$` cost only when it reports none. Window labels and reset countdowns live in
    `SessionDetailSheet`, which the usage cluster opens.
  - `App/Sources/Session/ComposerView.swift` — the input card, in two shapes. At rest it is the
    field and nothing else; once it has focus, a draft, or a turn to stop, an action row unfolds
    underneath (attach, dictate, hide keyboard, send). One send button does both jobs: a draft
    always sends — messages queue behind a running turn — and stop takes the slot only while a
    turn is live *and* there is nothing to send. Tapping the transcript puts the keyboard away.
  - `App/Sources/Session/PromptSuggestionList.swift` — the `/` and `@` picker, filling everything
    the header and the floating stack leave. It is a **`ZStack` sibling of the transcript, not an
    overlay on it**: an overlay on a `ScrollView` is proposed the scroll content's *ideal* size
    (measured at 305×616 on a 402×874 screen), so the panel came out neither full width nor full
    height. Inside the stack the frame is already safe-area-inset, so the only offset it needs is
    the floating stack's own measured height. The status bar steps aside while it is open, and the
    panel's height is fixed rather than fitted to the rows — a list that shrank as the filter
    narrowed would move the row you were reaching for.
  - `App/Sources/Support/GlassPanel.swift` — the one translucency decision, in one place.
    `glassEffect` on iOS 26, a blurred material with a hairline border below it. Nothing in the
    session screen is docked: the navigation bar and the bottom stack (warnings, approval, status
    bar, composer) both float, and the transcript scrolls under them.
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
  - `App/Sources/Files/` — the host file browser, reached from the folder button in an open
    session's toolbar. **Scoped to that session's `cwd`**: rooted there, with no roots list and no
    way up, because what you want on a phone is this project's tree, not an inventory of what the
    gateway exposes. (The server's `--fs-root` roots are still the security boundary; this scope
    is only what's offered.) Directory per navigation level so the stack *is* the path, a
    monospaced `TextEditor` for text files, base64 content refused rather than opened. Three
    server facts drive the UI: `/fs/roots` 404s on a gateway with no `--cwd-root` and no
    `--fs-root`, which renders as "no file access" with the flag to add; a cwd outside those roots
    404s its listing, which gets its own screen because the fix is different (it should be rare —
    reading follows the cwd roots, so a session that was allowed to start is normally browsable);
    and `canWrite` is false without `--fs-write`, which hides Save. Saving sends the hash the read returned, so a 409 means the
    agent edited the file first — the alert offers Reload, never a force.
  - `App/Sources/Session/PromptCompletion.swift` — one suggestion list, two tokens. `/commands`
    come from the `capabilities` event, so filtering is local, synchronous and complete;
    `@files` are a search over `GET /fs/find`, debounced and single-flight, and a 404 turns file
    completion off for the session rather than re-asking per keystroke. The text half is
    `PromptTokens` in the kit. Accepting appends a space, which is also what closes the list.
  - `App/Sources/Session/RichTextEditor.swift` — the app's **only UIKit bridge**: a
    `UIViewRepresentable` over `UITextView`. On the 17.0 deployment target SwiftUI can neither
    style part of a draft nor say where the caret is, and both wants have the same fix — so the
    bridge buys styled tokens *and* mid-message completion at once. Styling goes through
    `textStorage` attributes (the undo stack and selection survive), skips while `markedTextRange`
    is non-nil (IME composition), and only paints *confirmed* tokens — the word still being typed
    stays plain. Everything else in `App/` remains plain SwiftUI.
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

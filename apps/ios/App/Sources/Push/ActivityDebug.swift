#if DEBUG
  import ActivityKit
  import Foundation
  import WorkerDeckActivity

  /// Raises a card locally, without a gateway or APNs.
  ///
  /// Two jobs. In the Simulator it is the only way to iterate the lock-screen and Dynamic Island
  /// layouts at all - neither push-to-start nor APNs works there. On a real phone it is the cheapest
  /// possible version of build step 9a: tap a button on a locally started card and read the log for
  /// which process performed the intent. If that says the app's bundle id, the whole
  /// buttons-run-in-the-app design holds and the rest of the intent work is ordinary.
  enum ActivityDebug {
    /// Returns what happened, because `Activity.request` is the one call here that fails for half a
    /// dozen reasons the user can fix - Live Activities switched off for the app, switched off
    /// device-wide, a payload over the cap - and every one of them looks identical from the outside:
    /// a button that does nothing.
    @discardableResult
    static func raise(phase: String) -> String {
      let info = ActivityAuthorizationInfo()
      guard info.areActivitiesEnabled else {
        return "Live Activities are off. Settings → WorkerDeck → Live Activities."
      }
      let attributes = SessionActivityAttributes(
        sessionId: "ses_debug", hostId: nil, engine: "claude", cwdLeaf: "workerdeck")
      let request: SessionActivityAttributes.Request? =
        switch phase {
        case SessionActivityPhase.approval:
          .init(id: "req_debug", kind: SessionActivityRequestKind.permission)
        case SessionActivityPhase.question:
          .init(
            id: "req_debug",
            kind: SessionActivityRequestKind.question,
            choices: [
              .init(index: 0, label: "Shared Keychain group"),
              .init(index: 1, label: "App Group"),
              .init(index: 2, label: "Hand off to the app"),
            ],
            inputJSON: #"{"questions":[{"question":"Which auth method?","header":"Auth method","options":[{"label":"Shared Keychain group"},{"label":"App Group"},{"label":"Hand off to the app"}]}]}"#)
        default:
          nil
        }
      let state = SessionActivityAttributes.ContentState(
        phase: phase,
        title: "Wire the forwarder",
        headline: phase == SessionActivityPhase.approval
          ? "Bash" : phase == SessionActivityPhase.question ? "Auth method" : "Reading client.ts",
        detail: phase == SessionActivityPhase.approval
          ? "pnpm --filter workerdeck test"
          : phase == SessionActivityPhase.question ? "Which auth method?" : nil,
        startedAtMs: Date().timeIntervalSince1970 * 1000 - 90_000,
        pendingCount: request == nil ? 0 : 1,
        steps: .init(done: 3, total: 7),
        request: request)
      do {
        let activity = try Activity.request(
          attributes: attributes, content: .init(state: state, staleDate: nil), pushType: nil)
        return "Raised \(activity.id)."
      } catch {
        return "\(error)"
      }
    }

    /// What ActivityKit actually holds right now. The difference between "the push never arrived"
    /// and "the card arrived and something ended it" is invisible from the lock screen, and every
    /// wrong guess about it costs a deploy cycle.
    static func inventory() -> String {
      let token = Activity<SessionActivityAttributes>.pushToStartToken
        .map { data in data.map { String(format: "%02x", $0) }.joined() }
      // The token the gateway holds goes stale on every reinstall, and a push to a stale
      // push-to-start token is accepted by Apple and then dropped by the phone - no 410, no card,
      // nothing to read anywhere. Printing the live one is the only way to catch the mismatch.
      // Head **and** tail: two push-to-start tokens for the same app on the same device share a
      // long prefix, so a 16-character comparison against the gateway's copy proves nothing.
      let shown = token.map { "\($0.prefix(8))…\($0.suffix(8)) (\($0.count))" } ?? "none"
      let header = "start-token: \(shown) · enabled: \(ActivityAuthorizationInfo().areActivitiesEnabled)"
      let all = Activity<SessionActivityAttributes>.activities
      guard !all.isEmpty else { return "\(header)\nNo cards." }
      return header + "\n" + all
        .map { "\($0.attributes.sessionId.prefix(8)) \($0.activityState) \($0.content.state.phase) token:\($0.pushToken == nil ? "no" : "yes")" }
        .joined(separator: "\n")
    }

    static func endAll() async {
      for activity in Activity<SessionActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }
#endif

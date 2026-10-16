import SwiftUI
import UIKit

/// Process-wide reader preferences, persisted to `UserDefaults`.
///
/// One object for the whole app rather than a per-session choice: how a
/// transcript should read is a property of the reader, not of the session being
/// read. Follows the house pattern (`SessionListModel.config`) - `@Observable`,
/// injected defaults, `didSet` persist - rather than `@AppStorage`, so the
/// storage stays testable and the keys stay namespaced in one place.
/// Whether a Live Activity's Approve button may act while the phone is locked.
///
/// The notification's Approve is a `UNNotificationAction` with `.authenticationRequired`, so iOS
/// demands Face ID before it runs. **A Live Activity button has no equivalent** - this setting is
/// the only thing standing between a locked phone in a pocket and an approved tool call. Deny is
/// never gated: the worst a stray tap can do is refuse something the agent can ask for again.
enum ApproveWhileLocked: String, Codable, CaseIterable, Sendable {
  /// Approve only while unlocked; locked taps paint "Unlock to approve".
  case unlockedOnly
  case always
  /// Approve opens the app instead of acting.
  case never

  var label: String {
    switch self {
    case .unlockedOnly: "When unlocked"
    case .always: "Always"
    case .never: "Open the app"
    }
  }
}

/// Which session events are allowed to buzz this device.
///
/// The raw values are `SessionNotificationType` in `packages/protocol`, sent to every gateway as
/// the `notify` array on the device registration (`/apns/devices`). The gateway sends nothing this
/// list leaves out, so turning one off here stops the push at the source rather than hiding it on
/// arrival - which is the point, on a phone watching several sessions at once.
enum PushEvent: String, Codable, CaseIterable, Sendable {
  case permissionRequested = "permission_requested"
  case turnCompleted = "turn_completed"
  case sessionError = "session_error"
  case sessionClosed = "session_closed"

  var label: String {
    switch self {
    case .permissionRequested: "Approvals and questions"
    case .turnCompleted: "Turn finished"
    case .sessionError: "Errors"
    case .sessionClosed: "Session ended"
    }
  }

  /// The gateway's own default (`DEFAULT_NOTIFY` in `packages/cli/src/apns/devices.ts`), restated
  /// so a fresh install and a gateway that has never heard from it agree on what happens.
  static let standard: Set<PushEvent> = [.permissionRequested, .turnCompleted, .sessionError]
}

@MainActor
@Observable
final class AppSettings {
  /// The master switch. Off sends the gateway an empty allowlist rather than deleting the device
  /// token: the registration survives, so turning it back on is one POST and not a re-authorization.
  var pushEnabled: Bool {
    didSet { defaults.set(pushEnabled, forKey: Self.pushEnabledKey) }
  }

  var pushEvents: Set<PushEvent> {
    didSet { defaults.set(pushEvents.map(\.rawValue).sorted(), forKey: Self.pushEventsKey) }
  }

  /// Whether this device wants the per-session card at all. Off withholds the push-to-start token,
  /// which is the only thing that lets a gateway raise one - see `ActivityCoordinator`.
  var liveActivitiesEnabled: Bool {
    didSet { defaults.set(liveActivitiesEnabled, forKey: Self.liveActivitiesKey) }
  }

  /// What goes on the wire. Sorted so an unchanged choice compares equal on the gateway and does
  /// not rewrite its device file on every foreground.
  var notifyEvents: [String] {
    pushEnabled ? pushEvents.map(\.rawValue).sorted() : []
  }

  /// See `ApproveWhileLocked`. Defaults to the safe arm.
  var approveWhileLocked: ApproveWhileLocked {
    didSet { defaults.set(approveWhileLocked.rawValue, forKey: Self.approveLockKey) }
  }

  /// Catch-up mode: whether reopening a session marks where you left off - the
  /// recap seam, the faded rows above it and the "N new since" bar. On by
  /// default, matching the other two clients. Off is for a reader who hops
  /// between sessions constantly, for whom the marker is noise rather than news.
  var catchUpMode: Bool {
    didSet { defaults.set(catchUpMode, forKey: Self.catchUpKey) }
  }

  /// Thinking rows in the transcript, folded to one line. Lines the model wrote to the reader as
  /// thinking are drawn as replies and never hidden.
  var showThinking: Bool {
    didSet { defaults.set(showThinking, forKey: Self.thinkingKey) }
  }

  private let defaults: UserDefaults

  private static let catchUpKey = "bi.atomic.workerdeck.ios.catchUpMode"
  private static let thinkingKey = "bi.atomic.workerdeck.ios.showThinking"
  private static let approveLockKey = "bi.atomic.workerdeck.ios.approveWhileLocked"
  private static let pushEnabledKey = "bi.atomic.workerdeck.ios.pushEnabled"
  private static let pushEventsKey = "bi.atomic.workerdeck.ios.pushEvents"
  private static let liveActivitiesKey = "bi.atomic.workerdeck.ios.liveActivitiesEnabled"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    catchUpMode = defaults.object(forKey: Self.catchUpKey) as? Bool ?? true
    showThinking = defaults.object(forKey: Self.thinkingKey) as? Bool ?? true
    approveWhileLocked =
      defaults.string(forKey: Self.approveLockKey).flatMap(ApproveWhileLocked.init(rawValue:)) ?? .unlockedOnly
    pushEnabled = defaults.object(forKey: Self.pushEnabledKey) as? Bool ?? true
    liveActivitiesEnabled = defaults.object(forKey: Self.liveActivitiesKey) as? Bool ?? true
    // An absent key is a reader who has never chosen, not one who chose nothing - the empty set is
    // a real answer (every event off) and only a stored array may produce it.
    pushEvents =
      (defaults.array(forKey: Self.pushEventsKey) as? [String])
      .map { Set($0.compactMap(PushEvent.init(rawValue:))) } ?? PushEvent.standard
  }
}

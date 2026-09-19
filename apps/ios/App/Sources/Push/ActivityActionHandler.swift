import Foundation
import LocalAuthentication
import UIKit
import WorkerDeckActivity
import WorkerDeckKit

/// Performs a Live Activity button, in the app process.
///
/// The system launches the app in the background to run a `LiveActivityIntent`, so this reaches the
/// Keychain and the gateway exactly as the notification-action path does - the widget extension
/// holds no credential and makes no call. `AppDelegate` installs this as
/// `SessionActivityActions.handler` at `didFinishLaunching`, which is the callback a scene-less
/// launch does run.
@MainActor
struct ActivityActionHandler {
  let hosts: HostStore
  let activities: ActivityCoordinator
  let settings: AppSettings

  func perform(_ action: SessionActivityAction) async {
    let sessionId = action.sessionId
    let hostId = hostId(of: action)

    if requiresUnlock(action), !isUnlocked() {
      await activities.paint(sessionId: sessionId, hostId: hostId, decision: SessionActivityDecision.locked)
      return
    }

    guard let client = client(for: hostId) else {
      await activities.paint(sessionId: sessionId, hostId: hostId, decision: SessionActivityDecision.failed)
      return
    }

    guard let decision = decision(for: action, sessionId: sessionId, hostId: hostId) else {
      // A choice whose input the card could not carry. Nothing sensible to submit, and submitting
      // the label alone would answer with a shape the runner does not read.
      await activities.paint(sessionId: sessionId, hostId: hostId, decision: SessionActivityDecision.failed)
      return
    }

    await activities.paint(sessionId: sessionId, hostId: hostId, decision: SessionActivityDecision.sending)
    do {
      try await client.resolvePermission(sessionId: sessionId, requestId: requestId(of: action), decision)
      await activities.paint(sessionId: sessionId, hostId: hostId, decision: SessionActivityDecision.sent)
    } catch let error as WorkerClientError {
      // 404 is answered-or-expired, 409 is parked. Both are the server telling the truth, and its
      // own push is already on the way to overwrite whatever this paints.
      let outcome =
        switch error.statusCode {
        case 404: SessionActivityDecision.gone
        case 409: SessionActivityDecision.parked
        default: SessionActivityDecision.failed
        }
      await activities.paint(sessionId: sessionId, hostId: hostId, decision: outcome)
    } catch {
      await activities.paint(sessionId: sessionId, hostId: hostId, decision: SessionActivityDecision.failed)
    }
  }

  // MARK: - The lock gate

  private func requiresUnlock(_ action: SessionActivityAction) -> Bool {
    switch action {
    case .deny:
      // Never gated: refusing is the safe direction, and a denied call can be asked for again.
      return false
    case .approve, .choose:
      return settings.approveWhileLocked == .unlockedOnly
    }
  }

  /// Two probes because neither alone is reliable in a background launch. `isProtectedDataAvailable`
  /// is the documented signal but is `true` during the grace period right after a lock; the Keychain
  /// canary asks the only question that matters - can this process read something that requires an
  /// unlocked device.
  private func isUnlocked() -> Bool {
    guard UIApplication.shared.isProtectedDataAvailable else { return false }
    return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) ? keychainReadable() : true
  }

  private func keychainReadable() -> Bool {
    let account = "bi.atomic.workerdeck.ios.unlockCanary"
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      // First run: write it while we demonstrably can, and treat this launch as unlocked - the app
      // only reaches here from a tap, which needs a lit screen.
      SecItemAdd(
        [
          kSecClass as String: kSecClassGenericPassword,
          kSecAttrAccount as String: account,
          kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
          kSecValueData as String: Data([1]),
        ] as CFDictionary, nil)
      return true
    }
    return status == errSecSuccess
  }

  // MARK: - Decisions

  private func decision(for action: SessionActivityAction, sessionId: String, hostId: String?) -> ResolvePermissionRequest? {
    switch action {
    case .approve:
      return .allow()
    case .deny:
      return .deny(message: "Denied from the Live Activity", interrupt: false)
    case .choose(_, _, _, let choiceIndex):
      guard
        let request = activities.request(sessionId: sessionId, hostId: hostId),
        let inputJSON = request.inputJSON,
        let updated = answeredInput(inputJSON: inputJSON, choiceIndex: choiceIndex)
      else { return nil }
      return .allow(updatedInput: updated)
    }
  }

  /// An answer is the original tool input with an `answers` object added, keyed by question text -
  /// the same encoding `QuestionPromptView.submit` uses, and what `codexAnswers` reads on the other
  /// engine. The **full** label is read back out of the input, so a button truncated for drawing
  /// still submits the whole thing.
  private func answeredInput(inputJSON: String, choiceIndex: Int) -> [String: JSONValue]? {
    guard
      let data = inputJSON.data(using: .utf8),
      let input = try? JSONDecoder().decode([String: JSONValue].self, from: data),
      case .array(let questions)? = input["questions"],
      case .object(let first)? = questions.first,
      case .string(let text)? = first["question"],
      case .array(let options)? = first["options"],
      choiceIndex < options.count,
      case .object(let option) = options[choiceIndex],
      case .string(let label)? = option["label"]
    else { return nil }
    var updated = input
    updated["answers"] = .object([text: .string(label)])
    return updated
  }

  private func hostId(of action: SessionActivityAction) -> String? {
    switch action {
    case .approve(_, let hostId, _), .deny(_, let hostId, _), .choose(_, let hostId, _, _): hostId
    }
  }

  private func requestId(of action: SessionActivityAction) -> String {
    switch action {
    case .approve(_, _, let requestId), .deny(_, _, let requestId), .choose(_, _, let requestId, _): requestId
    }
  }

  private func client(for hostId: String?) -> WorkerClient? {
    let host =
      hostId.flatMap { UUID(uuidString: $0) }.flatMap { id in hosts.hosts.first { $0.id == id } }
      ?? hosts.selectedHost
    return host?.makeClient()
  }
}

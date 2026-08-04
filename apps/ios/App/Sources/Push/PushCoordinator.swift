import Observation
import UIKit
import UserNotifications
import WorkerDeckKit

/// Everything push: authorization, the device token, per-host registration, and
/// the route a tapped notification wants opened.
///
/// Why the app needs this at all — iOS will not hold a WebSocket open in the
/// background, so "the agent is waiting for your approval" can only reach the
/// phone as a push. The WS is for while you are looking at the screen; APNs is
/// the resume signal for every other moment.
@MainActor
@Observable
final class PushCoordinator {
  /// Set when a notification asks for a session to be opened. The view layer
  /// consumes it and calls `clearRoute()`.
  private(set) var pendingRoute: PushRoute?
  private(set) var authorization: UNAuthorizationStatus = .notDetermined
  /// Hex device token, nil until APNs hands one over. Nil forever on the
  /// Simulator, which has no APNs connection.
  private(set) var deviceToken: String?
  /// Last registration failure. Surfaced, not thrown: push is an enhancement,
  /// and a gateway without a forwarder is a perfectly normal state.
  private(set) var lastError: String?

  private var hosts: HostStore?
  /// `hostId|token` pairs already accepted, so re-syncing on every foreground is
  /// a no-op instead of a burst of POSTs.
  private var synced: Set<String> = []

  /// Called once from the app entry, with the store that owns the gateway list.
  func attach(hosts: HostStore) {
    guard self.hosts == nil else { return }
    self.hosts = hosts
    registerCategories()
    Task { await requestAuthorization() }
  }

  // MARK: - Authorization and token

  private func requestAuthorization() async {
    let center = UNUserNotificationCenter.current()
    // Asking every launch is harmless: iOS prompts once and answers from its
    // own record thereafter. What it buys is picking up a user who granted
    // permission in Settings after declining here.
    let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge]))
      ?? false
    authorization = await center.notificationSettings().authorizationStatus
    guard granted else { return }
    // Re-registering on every launch is Apple's own advice — the token can
    // change on restore, reinstall, or at the system's discretion.
    UIApplication.shared.registerForRemoteNotifications()
  }

  func didRegister(tokenData: Data) {
    let hex = tokenData.map { String(format: "%02x", $0) }.joined()
    if hex != deviceToken {
      deviceToken = hex
      // A new token invalidates every gateway's copy of the old one.
      synced.removeAll()
    }
    lastError = nil
    Task { await syncRegistrations() }
  }

  func didFailToRegister(_ error: Error) {
    lastError = error.localizedDescription
  }

  /// Push this device's token at every configured gateway that has not already
  /// accepted it. Safe to call often — the view layer drives it off the host
  /// list, so adding a server registers with it immediately.
  func syncRegistrations() async {
    guard let token = deviceToken, let hosts else { return }
    for host in hosts.hosts where host.isValid {
      let key = "\(host.id.uuidString)|\(token)"
      if synced.contains(key) { continue }
      do {
        // `unsupported` counts as synced: a gateway with no forwarder will not
        // grow one without a restart, and retrying it on every foreground would
        // be pure noise.
        _ = try await DeviceRegistration.register(token: token, host: host)
        synced.insert(key)
      } catch {
        lastError = "\(host.displayName): \(error.localizedDescription)"
      }
    }
  }

  // MARK: - Delivery

  /// A tap or an action on a notification, reduced by the delegate to the two
  /// Sendable things that matter — the `UN…` types themselves cannot cross onto
  /// the main actor.
  func handle(action: String, payload: PushPayload?) async {
    guard let payload else { return }

    switch action {
    case PushAction.approve, PushAction.deny:
      await resolve(payload: payload, allow: action == PushAction.approve)
    case UNNotificationDefaultActionIdentifier:
      pendingRoute = PushRoute(hostId: payload.hostId, sessionId: payload.sessionId)
    default:
      // Dismissal, or an action identifier from a build that is not this one.
      return
    }
  }

  func clearRoute() {
    pendingRoute = nil
  }

  /// Answer a permission request straight from the notification, without the app
  /// ever coming to the foreground. This is the REST counterpart of the WS
  /// `permission_decision` command, and the reason the payload carries
  /// `requestId` at all.
  private func resolve(payload: PushPayload, allow: Bool) async {
    guard let requestId = payload.requestId, let client = client(for: payload.hostId) else {
      return
    }
    do {
      try await client.resolvePermission(
        sessionId: payload.sessionId,
        requestId: requestId,
        allow ? .allow() : .deny(message: "Denied from a notification", interrupt: false))
    } catch {
      // It may have expired, or been answered on the desktop a second earlier.
      // Either way the tap deserves an answer rather than silence.
      await postLocal(
        title: allow ? "Approve failed" : "Deny failed",
        body: error.localizedDescription,
        payload: payload)
    }
  }

  /// The gateway a payload names, falling back to whichever host is open — a
  /// hand-crafted `simctl push` carries no `hostId`, and that is the case this
  /// fallback exists for.
  private func client(for hostId: UUID?) -> WorkerClient? {
    guard let hosts else { return nil }
    let host = hostId.flatMap { id in hosts.hosts.first { $0.id == id } } ?? hosts.selectedHost
    return host?.makeClient()
  }

  private func postLocal(title: String, body: String, payload: PushPayload) async {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.userInfo = ["sessionId": payload.sessionId, "type": payload.type]
    if let hostId = payload.hostId { content.userInfo["hostId"] = hostId.uuidString }
    content.threadIdentifier = payload.sessionId
    try? await UNUserNotificationCenter.current().add(
      UNNotificationRequest(
        identifier: UUID().uuidString, content: content, trigger: nil))
  }

  // MARK: - Categories

  /// The category identifiers are wire contract with the forwarder: it decides
  /// which one a payload carries, and a mismatch means a notification arrives
  /// with no Approve/Deny buttons at all.
  private func registerCategories() {
    let approve = UNNotificationAction(
      identifier: PushAction.approve,
      title: "Approve",
      // Approving lets an agent write to the operator's filesystem — that is not
      // something a locked phone in a pocket should be able to do.
      options: [.authenticationRequired])
    let deny = UNNotificationAction(
      identifier: PushAction.deny,
      title: "Deny",
      options: [.authenticationRequired, .destructive])
    let permission = UNNotificationCategory(
      identifier: PushCategory.permissionRequest,
      actions: [approve, deny],
      intentIdentifiers: [],
      options: [])
    let event = UNNotificationCategory(
      identifier: PushCategory.sessionEvent,
      actions: [],
      intentIdentifiers: [],
      options: [])
    UNUserNotificationCenter.current().setNotificationCategories([permission, event])
  }
}

import UIKit
import UserNotifications

/// The bridge between UIKit's push callbacks and `PushCoordinator`.
///
/// SwiftUI has no native remote-notification surface: `registerForRemoteNotifications()`
/// answers through `UIApplicationDelegate` and nowhere else, so a delegate is not
/// optional here. It stays a thin adapter — every decision lives in the
/// coordinator, which the app entry pulls out of `push` and puts in the
/// environment.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  let push = PushCoordinator()

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    push.didRegister(tokenData: deviceToken)
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    push.didFailToRegister(error)
  }

  // MARK: - UNUserNotificationCenterDelegate

  // Both requirements are `nonisolated`, and none of the `UN…` types are
  // Sendable, so a `@MainActor` witness cannot satisfy them. The delegate stays
  // off the main actor here and reduces the notification to Sendable facts
  // before hopping — which is all `PushCoordinator` ever wanted anyway.

  /// Show the banner in the foreground too — except for the session already on
  /// screen, whose news is arriving over the socket. `PushCoordinator` owns that
  /// judgement; this only reduces the notification to something Sendable first.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    let payload = PushPayload(userInfo: notification.request.content.userInfo)
    return await MainActor.run { self.push.presentationOptions(for: payload) }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    let action = response.actionIdentifier
    let payload = PushPayload(userInfo: response.notification.request.content.userInfo)
    await push.handle(action: action, payload: payload)
  }
}

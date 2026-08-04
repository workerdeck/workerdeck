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

  /// Show the banner even when the app is foregrounded. The app holds a WebSocket
  /// only for the session on screen, so a permission request raised by a
  /// *different* session is exactly as invisible in the foreground as it is in
  /// the background.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound, .list]
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

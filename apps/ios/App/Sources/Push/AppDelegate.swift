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

  // Both requirements are `nonisolated` and none of the `UN…` types are
  // Sendable (still true in the iOS 26.5 SDK — the protocol carries no actor or
  // sendability audit), so a `@MainActor` witness cannot satisfy them; Swift 6's
  // escape hatches (`@preconcurrency`, an isolated conformance) only turn that
  // error into a runtime isolation assert that bets on UIKit calling the
  // delegate on the main thread, which the SDK deliberately does not promise.
  //
  // But the **`async` forms of these witnesses are a trap, and the one that
  // shipped**: the compiler's synthesized `@objc` thunk invokes UIKit's
  // completion block on whatever executor the task finishes on — a
  // cooperative-pool thread — and `didReceive`'s completion drives
  // snapshot/state-restoration work that asserts main thread. Every
  // notification tap aborted on that assert (`NSInternalInconsistencyException:
  // 'Call must be made on main thread'`).
  //
  // So the witnesses are the completion-handler forms: reduce the notification
  // to Sendable facts on whatever thread the callback arrives on, hop to the
  // main actor for the decision, and call the completion from there — the one
  // thread UIKit's completions are known to tolerate. `@Sendable` on the blocks
  // declares that crossing; block sendability is not part of the ObjC type, so
  // the witness still matches the requirement.

  /// Show the banner in the foreground too — except for the session already on
  /// screen, whose news is arriving over the socket. `PushCoordinator` owns that
  /// judgement; this only reduces the notification to something Sendable first.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler:
      @escaping @Sendable (UNNotificationPresentationOptions) -> Void
  ) {
    let payload = PushPayload(userInfo: notification.request.content.userInfo)
    Task { @MainActor in
      completionHandler(self.push.presentationOptions(for: payload))
    }
  }

  /// The completion is deliberately called only after `handle` finishes: for a
  /// lock-screen Approve/Deny the app is woken in the background, and the
  /// completion is the signal that it may be suspended again — completing
  /// early would cut the REST call off mid-flight.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping @Sendable () -> Void
  ) {
    let action = response.actionIdentifier
    let payload = PushPayload(userInfo: response.notification.request.content.userInfo)
    Task { @MainActor in
      await self.push.handle(action: action, payload: payload)
      completionHandler()
    }
  }
}

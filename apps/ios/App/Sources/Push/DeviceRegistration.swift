import Foundation
import WorkerDeckKit

/// Registers this device's APNs token with one gateway.
///
/// A bare `URLSession` call rather than a `WorkerClient` method on purpose:
/// `/apns/devices` is served by the turnkey CLI's forwarder, not by
/// `packages/server`, so it is not part of the protocol `WorkerDeckKit` mirrors.
/// Keeping it out here keeps the kit an honest mirror.
enum DeviceRegistration {
  /// What a gateway is told. `hostId` is opaque to the server — it stores the
  /// string and echoes it back in every push, which is what lets an install with
  /// two gateways tell which one woke it.
  struct Body: Encodable {
    let token: String
    let environment: String
    let hostId: String
    let bundleId: String
    let platform = "ios"
  }

  enum Outcome: Sendable {
    case registered
    /// The gateway has no push forwarder. A normal state, not a failure — most
    /// instances will never configure one.
    case unsupported
  }

  static func register(token: String, host: Host) async throws -> Outcome {
    guard let url = host.pushRegistrationURL else { return .unsupported }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    let key = host.authKey.trimmingCharacters(in: .whitespacesAndNewlines)
    if !key.isEmpty { request.setValue("Bearer \(key)", forHTTPHeaderField: "authorization") }
    request.httpBody = try JSONEncoder().encode(
      Body(
        token: token,
        environment: PushEnvironment.current.rawValue,
        hostId: host.id.uuidString,
        bundleId: Bundle.main.bundleIdentifier ?? ""))

    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    // 404 is the contract. 405 is what a gateway built before that contract was
    // enforced answers: with no forwarder configured the path went unclaimed and
    // the dashboard's SPA catch-all — which serves GET and HEAD only — replied
    // for it. Both mean the same thing here, and treating 405 as a failure made
    // every push-less gateway a permanent error the app retried forever.
    if status == 404 || status == 405 { return .unsupported }
    guard (200..<300).contains(status) else {
      let detail = String(decoding: data.prefix(200), as: UTF8.self)
      throw WorkerClientError(
        message: detail.isEmpty ? "device registration failed" : detail, statusCode: status)
    }
    return .registered
  }
}

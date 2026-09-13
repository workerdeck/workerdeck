import Foundation
import WorkerDeckKit

/// Reports a Live Activity's update token to the gateway that raised the card.
///
/// A bare `URLSession` call for the same reason `DeviceRegistration` is one: `/apns/activities` is
/// the turnkey CLI's forwarder, not part of the protocol `WorkerDeckKit` mirrors.
enum ActivityRegistration {
  struct Body: Encodable {
    let sessionId: String
    let token: String
    let environment: String
    /// Lets the gateway match on `(device, session)` rather than guessing from the session alone,
    /// which it refuses to do when two phones are waiting on the same one.
    let deviceToken: String?
  }

  struct Delete: Encodable {
    let token: String
  }

  enum Outcome: Sendable {
    case attached
    /// This gateway did not raise that card — a second host the app tried because the attributes
    /// carried no `hostId`. The app forgets the token rather than retrying.
    case unknown
    case unsupported
  }

  static func attach(sessionId: String, token: String, deviceToken: String?, host: Host) async throws -> Outcome {
    try await send(
      host: host,
      method: "POST",
      body: Body(
        sessionId: sessionId, token: token, environment: PushEnvironment.current.rawValue,
        deviceToken: deviceToken))
  }

  static func detach(token: String, host: Host) async throws -> Outcome {
    try await send(host: host, method: "DELETE", body: Delete(token: token))
  }

  private static func send(host: Host, method: String, body: some Encodable) async throws -> Outcome {
    guard let url = host.activityRegistrationURL else { return .unsupported }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    let key = host.authKey.trimmingCharacters(in: .whitespacesAndNewlines)
    if !key.isEmpty { request.setValue("Bearer \(key)", forHTTPHeaderField: "authorization") }
    request.httpBody = try JSONEncoder().encode(body)

    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    // 404 means either "no forwarder" or "not my card". Both end the same way for the caller — stop
    // asking this host — so they are not worth telling apart, and 405 is the pre-contract gateway
    // whose SPA catch-all answered for an unclaimed path (see DeviceRegistration).
    if status == 404 || status == 405 { return method == "POST" ? .unknown : .unsupported }
    guard (200..<300).contains(status) else {
      let detail = String(decoding: data.prefix(200), as: UTF8.self)
      throw WorkerClientError(
        message: detail.isEmpty ? "activity registration failed" : detail, statusCode: status)
    }
    return .attached
  }
}

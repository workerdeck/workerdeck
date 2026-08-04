import Foundation
import WorkerDeckKit

/// A workerdeck gateway this app can drive.
///
/// `baseURL` is stored exactly as the user typed it — the server's *root*, e.g.
/// `http://your-mac.tailnet-name.ts.net:8787`. The `/v1` API prefix is an
/// implementation detail of the protocol, so `apiURL` appends it rather than
/// making anyone remember it.
struct Host: Codable, Identifiable, Hashable, Sendable {
  var id: UUID
  var name: String
  var baseURL: String
  /// The gateway's `--auth-key`. Empty means an unauthenticated server.
  var authKey: String

  init(id: UUID = UUID(), name: String = "", baseURL: String = "", authKey: String = "") {
    self.id = id
    self.name = name
    self.baseURL = baseURL
    self.authKey = authKey
  }

  /// REST base for `WorkerClient`: the typed root, normalized and suffixed with
  /// `/v1`. Nil when the field is blank or unparseable.
  var apiURL: URL? {
    var text = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    while text.hasSuffix("/") { text.removeLast() }
    guard !text.isEmpty else { return nil }
    // A bare `mac.tailnet.ts.net:8787` is a host:port, not a scheme — tailnet
    // gateways are plain http, so that is the sane default to assume.
    if !text.contains("://") { text = "http://" + text }
    if !text.hasSuffix("/v1") { text += "/v1" }
    return URL(string: text)
  }

  /// Where this gateway takes APNs device-token registrations. Deliberately
  /// *not* under `/v1`: push is the turnkey CLI's forwarder, not part of the
  /// protocol the OSS server implements, so it mounts beside the dashboard
  /// rather than inside the API.
  var pushRegistrationURL: URL? {
    apiURL?.deletingLastPathComponent().appendingPathComponent("apns/devices")
  }

  /// A client for this gateway, or nil when the address does not parse.
  ///
  /// Shared by `HostContext` and `PushCoordinator` — the latter needs a client
  /// for a host that is *not* the selected one, because a push can name any
  /// gateway the app is registered with.
  func makeClient() -> WorkerClient? {
    guard let url = apiURL else { return nil }
    let key = authKey.trimmingCharacters(in: .whitespacesAndNewlines)
    return WorkerClient(baseURL: url, authKey: key.isEmpty ? nil : key)
  }

  /// Non-empty display label, falling back to the address when unnamed.
  var displayName: String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? displayAddress : trimmed
  }

  /// `host:port` when the URL parses, else whatever the user typed.
  var displayAddress: String {
    let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed.contains("://") ? trimmed : "http://" + trimmed),
      let host = url.host
    else { return trimmed }
    return url.port.map { "\(host):\($0)" } ?? host
  }

  var isValid: Bool { apiURL != nil }
}

import Foundation
import WorkerDeckCore

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

// A failed call, as the core classified the answer (`restError`): the gateway's own `{"error"}` when it gave one.
public struct WorkerClientError: Error, LocalizedError, Equatable, Sendable {
  public let message: String
  public let statusCode: Int?

  public init(message: String, statusCode: Int? = nil) {
    self.message = message
    self.statusCode = statusCode
  }

  public init(_ error: RestError) {
    self.init(message: error.message, statusCode: Int(error.status))
  }

  public var errorDescription: String? { message }
}

// The transport for a gateway: the core names every call (`HttpCall`) and classifies every answer; this moves the
// bytes and carries the key as `Authorization: Bearer`, on REST and on the socket handshake alike.
public struct WorkerClient: Sendable {
  // REST base including the version path, e.g. `http://127.0.0.1:8787/v1`.
  public let baseURL: URL
  public let authKey: String?

  private let urlSession: URLSession

  public init(baseURL: URL, authKey: String? = nil, urlSession: URLSession = .shared) {
    self.baseURL = baseURL
    self.authKey = authKey
    self.urlSession = urlSession
  }

  // MARK: - Transport

  // A JSON answer: anything else, or a refusal, throws as the core reads it.
  @discardableResult
  public func perform(_ call: HttpCall) async throws -> Data {
    let (data, response) = try await send(call)
    let status = UInt16(clamping: response.statusCode)
    let contentType = response.value(forHTTPHeaderField: "content-type")
    if let error = restError(status: status, contentType: contentType, body: String(decoding: data, as: UTF8.self)) {
      throw WorkerClientError(error)
    }
    return data
  }

  // Bytes (pictures, files, shell output): any 2xx is the answer, a refusal still reads as the core says.
  public func fetch(_ call: HttpCall) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await send(call)
    guard (200..<300).contains(response.statusCode) else {
      let status = UInt16(clamping: response.statusCode)
      let contentType = response.value(forHTTPHeaderField: "content-type")
      let error = restError(status: status, contentType: contentType, body: String(decoding: data, as: UTF8.self))
      throw error.map(WorkerClientError.init) ?? WorkerClientError(message: "The gateway answered \(status)", statusCode: Int(status))
    }
    return (data, response)
  }

  // The answer as it came, for a core view model that reads and classifies it itself; no answer is status 0.
  public func answer(_ call: HttpCall) async -> HttpAnswer {
    guard let (data, response) = try? await send(call) else {
      return HttpAnswer(status: 0, contentType: nil, body: "")
    }
    return HttpAnswer(
      status: UInt16(clamping: response.statusCode), contentType: response.value(forHTTPHeaderField: "content-type"),
      body: String(decoding: data, as: UTF8.self))
  }

  // An upload the core named: the body is the raw bytes under their own media type; no answer is status 0.
  public func upload(_ call: HttpCall, mediaType: String, data: Data) async -> HttpAnswer {
    guard let url = try? makeURL(call.path) else { return HttpAnswer(status: 0, contentType: nil, body: "") }
    var request = URLRequest(url: url)
    request.httpMethod = call.method
    request.setValue(mediaType, forHTTPHeaderField: "content-type")
    applyAuth(&request)
    guard let (body, response) = try? await urlSession.upload(for: request, from: data),
      let http = response as? HTTPURLResponse
    else { return HttpAnswer(status: 0, contentType: nil, body: "") }
    return HttpAnswer(
      status: UInt16(clamping: http.statusCode), contentType: http.value(forHTTPHeaderField: "content-type"),
      body: String(decoding: body, as: UTF8.self))
  }

  private func send(_ call: HttpCall) async throws -> (Data, HTTPURLResponse) {
    var request = URLRequest(url: try makeURL(call.path))
    request.httpMethod = call.method
    if let body = call.body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = Data(body.utf8)
    }
    applyAuth(&request)
    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw WorkerClientError(message: "The gateway did not answer")
    }
    return (data, http)
  }

  // MARK: - Sessions

  // `POST /sessions` as the core's create form built it; the returned id is what every session route takes.
  public func createSession(_ call: HttpCall) async throws -> SessionInfo {
    try decode(SessionResponse.self, from: try await perform(call)).session
  }

  public func listSessions() async throws -> [SessionInfo] {
    try await listSessionsBody().sessions
  }

  // The same list plus the body as received, for the core's list view model.
  public func listSessionsBody() async throws -> (sessions: [SessionInfo], body: String) {
    let data = try await perform(listSessionsCall())
    return (try decode(ListSessionsResponse.self, from: data).sessions, String(decoding: data, as: UTF8.self))
  }

  public func getSession(id: String) async throws -> SessionInfo {
    try decode(SessionResponse.self, from: try await perform(getSessionCall(id: id))).session
  }

  // MARK: - SDK sessions

  // An engine's on-disk sessions, for resume across gateway restarts.
  public func listSdkSessions(_ call: HttpCall) async throws -> [SdkSessionSummary] {
    try decode(ListSdkSessionsResponse.self, from: try await perform(call)).sdkSessions
  }

  // MARK: - Agents

  // `POST /agents` as the core's create form built it.
  public func createAgent(_ call: HttpCall) async throws -> AgentResponse {
    try decode(AgentResponse.self, from: try await perform(call))
  }

  // A new conversation for the agent: the session it started, when the gateway says.
  public func restartAgent(id: String, prompt: String? = nil) async throws -> SessionInfo? {
    try decode(AgentResponse.self, from: try await perform(restartAgentCall(id: id, prompt: prompt))).session
  }

  // Raw bytes at a path under the REST base, as the core names one (a produced file, a host `/fs/read`).
  public func bytes(path: String) async throws -> Data {
    try await raw(path).0
  }

  // MARK: - Plumbing

  private func applyAuth(_ request: inout URLRequest) {
    guard let authKey, !authKey.isEmpty else { return }
    request.setValue("Bearer \(authKey)", forHTTPHeaderField: "Authorization")
  }

  private func raw(_ path: String) async throws -> (Data, HTTPURLResponse) {
    try await fetch(HttpCall(method: "GET", path: path, body: nil))
  }

  private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    // Never a key-conversion strategy: the protocol types own their key spelling
    // (camelCase for workerdeck's own shapes, snake_case for API mirrors).
    try JSONDecoder().decode(type, from: data)
  }

  private func makeURL(_ path: String) throws -> URL {
    let string = Self.trimmedBase(baseURL) + path
    guard let url = URL(string: string) else {
      throw WorkerClientError(message: "Invalid URL: \(string)")
    }
    return url
  }

  private static func trimmedBase(_ url: URL) -> String {
    var string = url.absoluteString
    while string.hasSuffix("/") { string.removeLast() }
    return string
  }
}

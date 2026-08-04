import Foundation
import Testing

@testable import WorkerDeckKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

// MARK: - URLProtocol stub

private struct StubResponse: Sendable {
  var status: Int = 200
  var body: Data = Data("{}".utf8)
}

/// Shared stub state for `StubURLProtocol`. Lock-guarded because URLProtocol
/// hands us requests on URLSession's own queues.
private final class StubStore: @unchecked Sendable {
  static let shared = StubStore()

  private let lock = NSLock()
  private var handler: (@Sendable (URLRequest) -> StubResponse)?
  private var recorded: [URLRequest] = []

  func install(_ handler: @escaping @Sendable (URLRequest) -> StubResponse) {
    lock.lock()
    defer { lock.unlock() }
    self.handler = handler
    recorded = []
  }

  func handle(_ request: URLRequest) -> StubResponse {
    lock.lock()
    let handler = self.handler
    recorded.append(request)
    lock.unlock()
    return handler?(request) ?? StubResponse()
  }

  var requests: [URLRequest] {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }
}

private final class StubURLProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let stub = StubStore.shared.handle(request)
    let response = HTTPURLResponse(
      url: request.url!, statusCode: stub.status, httpVersion: "HTTP/1.1", headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: stub.body)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

private func makeStubClient(authKey: String? = "s3cret") -> WorkerClient {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [StubURLProtocol.self]
  return WorkerClient(
    baseURL: URL(string: "http://127.0.0.1:8787/v1")!,
    authKey: authKey,
    urlSession: URLSession(configuration: configuration))
}

private let sessionJSON = """
  {"session":{"id":"sess_1","status":"running","cwd":"/repo","createdAt":1722300000000,
   "lastSeq":0,"pendingPermissionCount":0,"profile":"main","model":"claude-opus-4",
   "permissionMode":"default"}}
  """

// MARK: - Tests

@Suite("WorkerClient", .serialized)
struct WorkerClientTests {
  @Test func sendsBearerTokenOnEveryRequest() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"sessions":[]}"#.utf8)) }
    let client = makeStubClient()

    _ = try await client.listSessions()

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer s3cret")
    #expect(request.url?.path == "/v1/sessions")
    #expect(request.httpMethod == "GET")
  }

  @Test func omitsAuthorizationWhenUnauthenticated() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"sessions":[]}"#.utf8)) }
    let client = makeStubClient(authKey: nil)

    _ = try await client.listSessions()

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
  }

  @Test func createSessionRoundTripsThroughTheEnvelope() async throws {
    StubStore.shared.install { _ in StubResponse(status: 201, body: Data(sessionJSON.utf8)) }
    let client = makeStubClient()

    let session = try await client.createSession(CreateSessionRequest(cwd: "/repo", profile: "main"))

    #expect(session.id == "sess_1")
    #expect(session.status == .running)
    #expect(session.cwd == "/repo")
    #expect(session.profile == "main")
    #expect(session.permissionMode == .default)
    #expect(session.resolvedEngine == .claude)

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "content-type") == "application/json")
  }

  @Test func surfacesTheServerErrorMessage() async throws {
    StubStore.shared.install { _ in
      StubResponse(status: 400, body: Data(#"{"error":"profile 'ghost' is not declared"}"#.utf8))
    }
    let client = makeStubClient()

    await #expect(throws: WorkerClientError(
      message: "profile 'ghost' is not declared", statusCode: 400)) {
      _ = try await client.createSession(CreateSessionRequest(cwd: "/repo", profile: "ghost"))
    }
  }

  @Test func synthesizesAMessageWhenTheBodyHasNone() async throws {
    StubStore.shared.install { _ in StubResponse(status: 502, body: Data("<html>".utf8)) }
    let client = makeStubClient()

    await #expect(throws: WorkerClientError(
      message: "GET /sessions failed with 502", statusCode: 502)) {
      _ = try await client.listSessions()
    }
  }

  @Test func percentEncodesPathSegments() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"session":{}}"#.utf8)) }
    let client = makeStubClient()

    _ = try? await client.getSession(id: "a/b c")

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.url?.absoluteString == "http://127.0.0.1:8787/v1/sessions/a%2Fb%20c")
  }

  @Test func encodesFilePathsPerSegmentPreservingSlashes() throws {
    let client = makeStubClient()
    let url = try client.sessionFileURL(sessionId: "sess 1", path: "/out/my report.md")
    #expect(
      url.absoluteString
        == "http://127.0.0.1:8787/v1/sessions/sess%201/files/out/my%20report.md")
  }

  @Test func downloadsSessionFileBytes() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data("# report".utf8)) }
    let client = makeStubClient()

    let data = try await client.fetchSessionFile(sessionId: "sess_1", path: "out/report.md")

    #expect(String(decoding: data, as: UTF8.self) == "# report")
    let request = try #require(StubStore.shared.requests.first)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer s3cret")
  }

  @Test func buildsSdkSessionQueryString() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"sdkSessions":[]}"#.utf8)) }
    let client = makeStubClient()

    _ = try await client.listSdkSessions(dir: "/repo", limit: 10, offset: 5)

    let request = try #require(StubStore.shared.requests.first)
    #expect(
      request.url?.absoluteString
        == "http://127.0.0.1:8787/v1/sdk-sessions?dir=%2Frepo&limit=10&offset=5")
  }

  @Test func postsPermissionDecisions() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data("{}".utf8)) }
    let client = makeStubClient()

    try await client.resolvePermission(
      sessionId: "sess_1", requestId: "req_1", .deny(message: "not now", interrupt: true))

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.path == "/v1/sessions/sess_1/permissions/req_1")
  }

  @Test func derivesTheWebSocketURLFromTheRestBase() throws {
    let insecure = WorkerClient(baseURL: URL(string: "http://host:8787/v1")!)
    #expect(
      try insecure.webSocketURL(sessionId: "sess_1", afterSeq: 12).absoluteString
        == "ws://host:8787/v1/sessions/sess_1/ws?afterSeq=12")

    let secure = WorkerClient(baseURL: URL(string: "https://host/v1/")!)
    #expect(
      try secure.webSocketURL(sessionId: "sess_1", afterSeq: 0).absoluteString
        == "wss://host/v1/sessions/sess_1/ws?afterSeq=0")
  }
}

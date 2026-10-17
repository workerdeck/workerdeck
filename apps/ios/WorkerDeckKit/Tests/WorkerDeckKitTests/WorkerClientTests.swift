import Foundation
import Testing

import WorkerDeckCore
@testable import WorkerDeckKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

// MARK: - URLProtocol stub

private struct StubResponse: Sendable {
  var status: Int = 200
  var body: Data = Data("{}".utf8)
  var contentType = "application/json; charset=utf-8"
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
      url: request.url!, statusCode: stub.status, httpVersion: "HTTP/1.1",
      headerFields: ["content-type": stub.contentType])!
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

    _ = try await client.perform(listSessionsCall())

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer s3cret")
    #expect(request.url?.path == "/v1/sessions")
    #expect(request.httpMethod == "GET")
  }

  @Test func omitsAuthorizationWhenUnauthenticated() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"sessions":[]}"#.utf8)) }
    let client = makeStubClient(authKey: nil)

    _ = try await client.perform(listSessionsCall())

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
  }

  @Test func createSessionRoundTripsThroughTheEnvelope() async throws {
    StubStore.shared.install { _ in StubResponse(status: 201, body: Data(sessionJSON.utf8)) }
    let client = makeStubClient()

    let body = try await client.perform(CreateForm.session(cwd: "/repo").call())
    let created = try #require(createdSession(body: String(decoding: body, as: UTF8.self)))

    #expect(created.sessionId == "sess_1")
    #expect(created.cwd == "/repo")

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
      _ = try await client.perform(CreateForm.session(cwd: "/repo").call())
    }
  }

  @Test func synthesizesAMessageWhenTheBodyHasNone() async throws {
    StubStore.shared.install { _ in StubResponse(status: 502, body: Data("<html>".utf8)) }
    let client = makeStubClient()

    await #expect(throws: WorkerClientError(
      message: "The gateway answered 502", statusCode: 502)) {
      _ = try await client.perform(listSessionsCall())
    }
  }

  @Test func anHtmlAnswerIsTheWrongAddressOrKey() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data("<html>".utf8), contentType: "text/html") }
    let client = makeStubClient()
    await #expect(throws: WorkerClientError(
      message: "Not a WorkerDeck gateway, or the auth key is wrong", statusCode: 200)) {
      _ = try await client.perform(listSessionsCall())
    }
  }

  @Test func bytesAcceptAnyContentType() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data("png".utf8), contentType: "image/png") }
    let client = makeStubClient()
    #expect(try await client.bytes(path: "/sessions/s/produced/f") == Data("png".utf8))
  }

  @Test func percentEncodesPathSegments() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"session":{}}"#.utf8)) }
    let client = makeStubClient()

    _ = try? await client.perform(getSessionCall(id: "a/b c"))

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.url?.absoluteString == "http://127.0.0.1:8787/v1/sessions/a%2Fb%20c")
  }

  @Test func fetchesSessionFileBytesWithTheKey() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data("# report".utf8), contentType: "text/markdown") }
    let client = makeStubClient()

    let (data, _) = try await client.fetch(sessionFileCall(sessionId: "sess 1", path: "/out/my report.md"))

    #expect(String(decoding: data, as: UTF8.self) == "# report")
    let request = try #require(StubStore.shared.requests.first)
    #expect(request.url?.absoluteString == "http://127.0.0.1:8787/v1/sessions/sess%201/files/out/my%20report.md")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer s3cret")
  }

  @Test func buildsSdkSessionQueryString() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"sdkSessions":[]}"#.utf8)) }
    let client = makeStubClient()

    _ = try await client.perform(listSdkSessionsCall(dir: "/repo", limit: 10, offset: 5, profile: "codex"))

    let request = try #require(StubStore.shared.requests.first)
    #expect(
      request.url?.absoluteString
        == "http://127.0.0.1:8787/v1/sdk-sessions?dir=%2Frepo&limit=10&offset=5&profile=codex")
  }

  @Test func postsPermissionDecisions() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data("{}".utf8)) }
    let client = makeStubClient()

    try await client.perform(
      resolvePermissionCall(
        sessionId: "sess_1", requestId: "req_1", decision: .deny(message: "not now", interrupt: true)))

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.path == "/v1/sessions/sess_1/permissions/req_1")
  }

  // MARK: - Answers and uploads

  @Test func anAnswerComesBackWholeForTheCoreToRead() async throws {
    StubStore.shared.install { _ in
      StubResponse(status: 409, body: Data(#"{"error":"file changed on disk since it was read"}"#.utf8))
    }
    let client = makeStubClient()
    let editor = HostFileEditor(path: "/repo/a.txt")
    editor.readAnswered(
      answer: HttpAnswer(
        status: 200, contentType: "application/json",
        body: #"{"path":"/repo/a.txt","content":"hi","encoding":"utf8","bytes":2,"hash":"h1","modifiedAt":1}"#))
    editor.setDraft(draft: "bye")

    let answer = await client.answer(try #require(editor.saveCall()))
    editor.saveAnswered(answer: answer)

    #expect(answer.status == 409)
    #expect(editor.state().conflict)
    #expect(editor.state().error == "file changed on disk since it was read")
    let request = try #require(StubStore.shared.requests.first)
    #expect(request.httpMethod == "PUT")
    #expect(request.url?.path == "/v1/fs/write")
  }

  @Test func percentEncodesTheHostQuery() async throws {
    StubStore.shared.install { _ in
      StubResponse(body: Data(#"{"base":"/repo","truncated":false,"matches":[{"path":"/repo/a.ts","relative":"a.ts"}]}"#.utf8))
    }
    let client = makeStubClient()

    let body = try await client.perform(findHostFilesCall(directory: "/repo", query: "a t", limit: 8))

    #expect(hostFileMatches(body: String(decoding: body, as: UTF8.self))?.first?.relative == "a.ts")
    let request = try #require(StubStore.shared.requests.first)
    #expect(request.url?.absoluteString == "http://127.0.0.1:8787/v1/fs/find?path=%2Frepo&q=a%20t&limit=8")
  }

  @Test func uploadsRawBytesUnderTheirMediaType() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"attachment":{"id":"att_1","name":"a b.png"}}"#.utf8)) }
    let client = makeStubClient()

    let answer = await client.upload(
      uploadAttachmentCall(sessionId: "s", name: "a b.png"), mediaType: "image/png", data: Data([1, 2, 3]))

    #expect(answer.status == 200)
    #expect(uploadedAttachmentId(body: answer.body) == "att_1")
    let request = try #require(StubStore.shared.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "content-type") == "image/png")
    #expect(request.url?.absoluteString == "http://127.0.0.1:8787/v1/sessions/s/attachments?name=a%20b.png")
  }

  @Test func renamePatchesTheSessionRoute() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(sessionJSON.utf8)) }
    let client = makeStubClient()

    try await client.perform(updateSessionCall(id: "sess_1", patch: SessionPatch(title: .set(value: "Named"))))

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.httpMethod == "PATCH")
    #expect(request.url?.path == "/v1/sessions/sess_1")
  }

  @Test func sleepPostsTheSessionSleepRoute() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(sessionJSON.utf8)) }
    let client = makeStubClient()

    try await client.perform(sleepSessionCall(id: "sess_1"))

    let request = try #require(StubStore.shared.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.path == "/v1/sessions/sess_1/sleep")
  }

  @Test func surfacesARefusedSleep() async throws {
    StubStore.shared.install { _ in
      StubResponse(status: 409, body: Data(#"{"error":"session is running"}"#.utf8))
    }
    let client = makeStubClient()

    await #expect(throws: WorkerClientError(message: "session is running", statusCode: 409)) {
      try await client.perform(sleepSessionCall(id: "sess_1"))
    }
  }

  @Test func backgroundTaskPostsTheTaskRouteOrTheBareOne() async throws {
    StubStore.shared.install { _ in StubResponse(body: Data(#"{"ok":true}"#.utf8)) }
    let client = makeStubClient()

    try await client.perform(backgroundTaskCall(sessionId: "sess_1", toolUseId: "tu_1"))
    try await client.perform(backgroundTaskCall(sessionId: "sess_1"))

    let paths = StubStore.shared.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }
    #expect(
      paths == [
        "POST /v1/sessions/sess_1/tasks/tu_1/background", "POST /v1/sessions/sess_1/tasks/background",
      ])
  }

  @Test func surfacesANothingToBackground() async throws {
    StubStore.shared.install { _ in
      StubResponse(status: 404, body: Data(#"{"error":"no foreground task to move to the background"}"#.utf8))
    }
    let client = makeStubClient()

    await #expect(
      throws: WorkerClientError(
        message: "no foreground task to move to the background", statusCode: 404)
    ) {
      try await client.perform(backgroundTaskCall(sessionId: "sess_1"))
    }
  }
}

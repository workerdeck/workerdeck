import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// A failed workerdeck call.
///
/// Mirrors the reference client's `#call`: when the server answered with a JSON
/// body carrying `{"error": "..."}` that message is used verbatim, otherwise the
/// message is synthesized as `"METHOD path failed with STATUS"`.
public struct WorkerClientError: Error, LocalizedError, Equatable, Sendable {
  /// Server-supplied message when the body had one, else a synthesized summary.
  public let message: String
  /// HTTP status, when the failure came from a response (nil for transport/URL errors).
  public let statusCode: Int?

  public init(message: String, statusCode: Int? = nil) {
    self.message = message
    self.statusCode = statusCode
  }

  public var errorDescription: String? { message }
}

/// REST + WebSocket client for a workerdeck gateway.
///
/// Swift port of `WorkerDeckClient` (packages/client/src/index.ts). The job
/// queue surface (`/jobs`, `/queue`) is deliberately not mirrored yet — it is a
/// later phase of the mobile plan.
///
/// Auth is the header transport: a native client is not a browser, so it never
/// relies on the login cookie the dashboard uses. `authKey` rides as
/// `Authorization: Bearer <key>` on every REST request *and* on the WebSocket
/// handshake (URLSession can set handshake headers; a browser cannot, which is
/// the whole reason the server also accepts a cookie).
public struct WorkerClient: Sendable {
  /// REST base including the version path, e.g. `http://127.0.0.1:8787/v1`.
  public let baseURL: URL
  /// Bearer token, or nil for an unauthenticated server.
  public let authKey: String?

  private let urlSession: URLSession
  /// Test seam: swaps `URLSessionWebSocketTransport` for a fake.
  private let socketFactory: (@Sendable (URLRequest, URLSession) -> any WebSocketConnecting)?

  public init(baseURL: URL, authKey: String? = nil, urlSession: URLSession = .shared) {
    self.init(baseURL: baseURL, authKey: authKey, urlSession: urlSession, socketFactory: nil)
  }

  init(
    baseURL: URL,
    authKey: String? = nil,
    urlSession: URLSession = .shared,
    socketFactory: (@Sendable (URLRequest, URLSession) -> any WebSocketConnecting)?
  ) {
    self.baseURL = baseURL
    self.authKey = authKey
    self.urlSession = urlSession
    self.socketFactory = socketFactory
  }

  // MARK: - Sessions

  /// Start a session. The returned info's `id` is what `attach` and every other
  /// session route take (not the underlying SDK session id).
  public func createSession(_ request: CreateSessionRequest) async throws -> SessionInfo {
    let data = try await call("POST", "/sessions", body: request)
    return try decode(SessionResponse.self, from: data).session
  }

  public func listSessions() async throws -> [SessionInfo] {
    let data = try await call("GET", "/sessions")
    return try decode(ListSessionsResponse.self, from: data).sessions
  }

  public func getSession(id: String) async throws -> SessionInfo {
    let data = try await call("GET", "/sessions/\(Self.encodeComponent(id))")
    return try decode(SessionResponse.self, from: data).session
  }

  /// Rename a session — a gateway edit, so the dashboard and the VS Code
  /// extension see the same name. Never a local override: a title only this
  /// device knows is a title nobody else can search for.
  @discardableResult
  public func updateSession(id: String, _ patch: UpdateSessionRequest) async throws -> SessionInfo {
    let data = try await call("PATCH", "/sessions/\(Self.encodeComponent(id))", body: patch)
    return try decode(SessionResponse.self, from: data).session
  }

  /// Terminate a session. Returns its final snapshot.
  @discardableResult
  public func deleteSession(id: String) async throws -> SessionInfo {
    let data = try await call("DELETE", "/sessions/\(Self.encodeComponent(id))")
    return try decode(SessionResponse.self, from: data).session
  }

  /// List the files in a session's scratch filesystem (deliverables the agent
  /// wrote; see the `file_delivered` event). 404s when the session's engine has
  /// no file store — Claude-engine sessions write to the real disk instead.
  public func listSessionFiles(sessionId: String) async throws -> [SessionFileInfo] {
    let data = try await call("GET", "/sessions/\(Self.encodeComponent(sessionId))/files")
    return try decode(ListSessionFilesResponse.self, from: data).files
  }

  /// Download one session file. Returned as bytes so binary deliverables survive;
  /// decode with `String(decoding:as:)` for text.
  public func fetchSessionFile(sessionId: String, path: String) async throws -> Data {
    let url = try sessionFileURL(sessionId: sessionId, path: path)
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    applyAuth(&request)
    let (data, response) = try await urlSession.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw Self.error(from: data, status: status, summary: "GET file")
    }
    return data
  }

  /// Direct download URL for a session file. Carries no headers — on an
  /// authenticated server use `fetchSessionFile` instead.
  public func sessionFileURL(sessionId: String, path: String) throws -> URL {
    try makeURL("/sessions/\(Self.encodeComponent(sessionId))/files/\(Self.encodeFilePath(path))")
  }

  // MARK: - Attachments

  /// Upload one file for a session, ahead of the message that will carry it.
  /// The returned attachment's `id` goes to `SessionHandle.send`.
  ///
  /// The body is the raw bytes — there is no multipart here, which is why this is
  /// a plain upload task and not a hand-rolled form encoder.
  public func uploadAttachment(
    sessionId: String, name: String, mediaType: String, data: Data
  ) async throws -> MessageAttachment {
    var components = URLComponents(
      url: try makeURL("/sessions/\(Self.encodeComponent(sessionId))/attachments"),
      resolvingAgainstBaseURL: false)
    components?.queryItems = [URLQueryItem(name: "name", value: name)]
    guard let url = components?.url else {
      throw WorkerClientError(message: "Invalid attachment upload URL")
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue(mediaType, forHTTPHeaderField: "content-type")
    applyAuth(&request)
    let (body, response) = try await urlSession.upload(for: request, from: data)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw Self.error(from: body, status: status, summary: "POST attachment")
    }
    return try decode(UploadAttachmentResponse.self, from: body).attachment
  }

  /// Download an attachment's bytes. Header auth means the phone fetches these
  /// itself rather than pointing an image view at a URL.
  public func fetchAttachment(sessionId: String, attachmentId: String) async throws -> Data {
    var request = URLRequest(
      url: try makeURL(
        "/sessions/\(Self.encodeComponent(sessionId))/attachments/\(Self.encodeComponent(attachmentId))"
      ))
    request.httpMethod = "GET"
    applyAuth(&request)
    let (data, response) = try await urlSession.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw Self.error(from: data, status: status, summary: "GET attachment")
    }
    return data
  }

  // MARK: - MCP

  /// The session's MCP servers and their tools, live from the engine. Throws 501
  /// when the engine has no MCP surface, 409 while the session is parked.
  public func listMcpServers(sessionId: String) async throws -> [McpServerStatusInfo] {
    let data = try await call("GET", "/sessions/\(Self.encodeComponent(sessionId))/mcp")
    return try decode(McpServersResponse.self, from: data).servers
  }

  /// Reconnect, enable or disable one server; answers with the refreshed list.
  public func mcpServerAction(
    sessionId: String, serverName: String, action: McpServerActionRequest.Action
  ) async throws -> [McpServerStatusInfo] {
    let data = try await call(
      "POST",
      "/sessions/\(Self.encodeComponent(sessionId))/mcp/\(Self.encodeComponent(serverName))",
      body: McpServerActionRequest(action: action))
    return try decode(McpServersResponse.self, from: data).servers
  }

  /// Resolve a pending permission over REST — the counterpart of the WS
  /// `permission_decision` command, for answering from a push notification or
  /// any context without a live attach. Throws when the request is unknown,
  /// already resolved, or expired.
  public func resolvePermission(
    sessionId: String, requestId: String, _ decision: ResolvePermissionRequest
  ) async throws {
    _ = try await call(
      "POST",
      "/sessions/\(Self.encodeComponent(sessionId))/permissions/\(Self.encodeComponent(requestId))",
      body: decision)
  }

  // MARK: - Profiles

  /// The profiles this caller may use, plus whether it may create new ones.
  /// Servers predating profiles 404 here — catch and treat as none declared.
  public func listProfiles() async throws -> ListProfilesResponse {
    let data = try await call("GET", "/profiles")
    return try decode(ListProfilesResponse.self, from: data)
  }

  /// One profile plus a view-only snapshot of its config directory (settings,
  /// skills, agents, commands — env var *names* only, never values).
  public func getProfile(name: String) async throws -> GetProfileResponse {
    let data = try await call("GET", "/profiles/\(Self.encodeComponent(name))")
    return try decode(GetProfileResponse.self, from: data)
  }

  // MARK: - SDK sessions

  /// List an engine's on-disk sessions, for resume across server restarts.
  /// Feed a result's `sessionId` to `CreateSessionRequest.resume` — under a
  /// profile of the same engine. `profile` names whose store to list (claude →
  /// the Agent SDK store, codex → CODEX_HOME threads); nil, the server resolves
  /// it implicitly when it declares exactly one profile, else lists the Claude
  /// engine's store.
  public func listSdkSessions(
    dir: String? = nil, limit: Int? = nil, offset: Int? = nil, profile: String? = nil
  )
    async throws -> [SdkSessionSummary]
  {
    var query: [String] = []
    if let dir { query.append("dir=\(Self.encodeQueryValue(dir))") }
    if let limit { query.append("limit=\(limit)") }
    if let offset { query.append("offset=\(offset)") }
    if let profile { query.append("profile=\(Self.encodeQueryValue(profile))") }
    let suffix = query.isEmpty ? "" : "?\(query.joined(separator: "&"))"
    let data = try await call("GET", "/sdk-sessions\(suffix)")
    return try decode(ListSdkSessionsResponse.self, from: data).sdkSessions
  }

  // MARK: - Host filesystem

  /// The host directories this server will let this client browse, and whether it
  /// accepts writes.
  ///
  /// Throws a 404 `WorkerClientError` when the server has no host-file roots
  /// configured — that is the normal answer, not a malfunction, and the caller
  /// should treat it as "no file browser on this host" the same way it treats a
  /// pre-profiles server 404ing `/profiles`.
  public func listHostRoots() async throws -> ListHostRootsResponse {
    let data = try await call("GET", "/fs/roots")
    return try decode(ListHostRootsResponse.self, from: data)
  }

  /// One host directory, not recursive. Symlinks come back as symlinks; reading one
  /// is what discovers whether it resolves somewhere this server allows.
  public func listHostDir(path: String) async throws -> ListHostDirResponse {
    let data = try await call("GET", "/fs/list?path=\(Self.encodeQueryValue(path))")
    return try decode(ListHostDirResponse.self, from: data)
  }

  /// Recursive fuzzy file search under one host directory — what backs `@file`
  /// completion in the composer. Subsequence matching, filename hits first. Cheap
  /// enough to call per keystroke: the server skips build directories and bounds
  /// the walk, truncating rather than failing.
  public func findHostFiles(in directory: String, matching query: String = "", limit: Int? = nil)
    async throws -> FindHostFilesResponse
  {
    var suffix =
      "?path=\(Self.encodeQueryValue(directory))&q=\(Self.encodeQueryValue(query))"
    if let limit { suffix += "&limit=\(limit)" }
    let data = try await call("GET", "/fs/find\(suffix)")
    return try decode(FindHostFilesResponse.self, from: data)
  }

  /// Read one host file. Binary content arrives base64-encoded; the returned `hash`
  /// is what a later `writeHostFile` needs as its `expectedHash`.
  public func readHostFile(path: String) async throws -> ReadHostFileResponse {
    let data = try await call("GET", "/fs/read?path=\(Self.encodeQueryValue(path))")
    return try decode(ReadHostFileResponse.self, from: data)
  }

  /// Write one host file. A 409 means the file changed since it was read — the
  /// agent edits this same tree, so the edit has to be rebased, never forced.
  @discardableResult
  public func writeHostFile(_ request: WriteHostFileRequest) async throws -> WriteHostFileResponse {
    let data = try await call("PUT", "/fs/write", body: request)
    return try decode(WriteHostFileResponse.self, from: data)
  }

  /// Fetch the bytes of a file this session's ENGINE produced — the `fileId` of
  /// a `file_produced` event (codex's generated images).
  ///
  /// Deliberately not `/fs/read`: this route needs no host-file roots declared
  /// and applies no byte cap, because its allowlist is the exact set of paths
  /// this session's own runner reported writing, not a directory grant. A
  /// generated PNG is routinely megabytes, which is what made the old path
  /// fail by default.
  public func readProducedFile(sessionId: String, fileId: String) async throws -> Data {
    try await call(
      "GET",
      "/sessions/\(Self.encodeComponent(sessionId))/produced/\(Self.encodeComponent(fileId))")
  }

  // MARK: - Live attach

  /// Open a live connection to a session's event stream.
  ///
  /// - Parameters:
  ///   - afterSeq: replay events with `seq` greater than this (0 = full replay).
  ///   - reconnect: auto-reconnect with backoff on unexpected disconnects.
  ///   - truncateResults: replay an oversized `tool_result` block as its **head**,
  ///     marked, with the rest one ``toolResult(sessionId:seq:toolUseId:)`` away.
  ///     Measured, three such frames were 68% of one 3.1 MB attach. Default off,
  ///     and permanently: only the unit that *renders* may ask for heads, since a
  ///     caller that cannot fetch them back would present one as the whole result.
  ///   - imageRefs: deliver a `tool_result`'s base64 image parts as `image_ref`
  ///     addresses, their bytes one ``toolResultImage(sessionId:seq:toolUseId:partIndex:)``
  ///     away. This is where the bytes actually were: 91% of all tool-result
  ///     payload across 214 sessions, and no client rendered a byte of it. Its
  ///     **own** flag rather than a widening of `truncateResults`, because this
  ///     family's "additive at protocol 7" argument rests on a client that never
  ///     asked being unable to receive one, by construction. Default off under
  ///     the same rule, and unlike truncation it applies to **live** events too:
  ///     the render path is ref-then-fetch, so bytes arriving live would only be
  ///     discarded or pinned in memory.
  @MainActor
  public func attach(
    sessionId: String, afterSeq: Int = 0, reconnect: Bool = true, truncateResults: Bool = false,
    imageRefs: Bool = false
  ) -> SessionHandle {
    let client = self
    return SessionHandle(sessionId: sessionId, afterSeq: afterSeq, reconnect: reconnect) { seq in
      try client.openSocket(
        sessionId: sessionId, afterSeq: seq, truncateResults: truncateResults,
        imageRefs: imageRefs)
    }
  }

  /// The whole of a tool result whose replay delivered only its head.
  ///
  /// `toolUseId` is required and the gateway verifies it against the block: a
  /// woken dormant session has a fresh log with fresh seqs, so a `sourceSeq`
  /// cached across a gateway restart can name a different event, and being handed
  /// another tool's output under the row you pressed is the exact failure this
  /// feature exists to remove. A 404 means "ask again after a fresh attach", not
  /// "empty".
  ///
  /// `imageRefs` matters here for the same reason it does on the socket: without
  /// it, pressing "show everything" on an image-bearing result ships every
  /// screenshot's base64 inside the JSON and this client keeps only the text.
  public func toolResult(
    sessionId: String, seq: Int, toolUseId: String, imageRefs: Bool = false
  ) async throws -> ToolResultResponse {
    let data = try await call(
      "GET",
      "/sessions/\(Self.encodeComponent(sessionId))/events/\(seq)/result?toolUseId=\(Self.encodeComponent(toolUseId))"
        + (imageRefs ? "&imageRefs=1" : "")
    )
    return try decode(ToolResultResponse.self, from: data)
  }

  /// One image part's bytes, addressed by the `image_ref` a replay delivered in
  /// its place.
  ///
  /// Fetched rather than pointed at, for the reason `fetchAttachment` is: the
  /// gateway authenticates with a header, so a `UIImageView` aimed at the URL
  /// would render a 401. The route answers **raw bytes** with a `Content-Type`,
  /// not JSON — base64 in a payload would double the memory and add a decode on
  /// the main thread for something `UIImage(data:)` already does.
  ///
  /// A 404 means "ask again after a fresh attach": a woken dormant session has a
  /// fresh log with fresh seqs, and the gateway verifies `toolUseId` against the
  /// block rather than serving another call's pixels under the row you are
  /// looking at.
  public func toolResultImage(
    sessionId: String, seq: Int, toolUseId: String, partIndex: Int
  ) async throws -> Data {
    try await call(
      "GET",
      "/sessions/\(Self.encodeComponent(sessionId))/events/\(seq)/result"
        + "?toolUseId=\(Self.encodeComponent(toolUseId))&part=\(partIndex)")
  }

  /// WebSocket URL for a session attach: the REST base with `http`→`ws`
  /// (`https`→`wss`), mirroring the reference client's `replace(/^http/, 'ws')`.
  public func webSocketURL(
    sessionId: String, afterSeq: Int, truncateResults: Bool = false, imageRefs: Bool = false
  ) throws -> URL {
    var base = Self.trimmedBase(baseURL)
    if base.hasPrefix("https") {
      base = "wss" + base.dropFirst("https".count)
    } else if base.hasPrefix("http") {
      base = "ws" + base.dropFirst("http".count)
    }
    let string =
      "\(base)/sessions/\(Self.encodeComponent(sessionId))/ws?afterSeq=\(afterSeq)"
      + (truncateResults ? "&truncateResults=1" : "")
      + (imageRefs ? "&imageRefs=1" : "")
    guard let url = URL(string: string) else {
      throw WorkerClientError(message: "Invalid WebSocket URL: \(string)")
    }
    return url
  }

  func openSocket(
    sessionId: String, afterSeq: Int, truncateResults: Bool = false, imageRefs: Bool = false
  ) throws -> any WebSocketConnecting {
    var request = URLRequest(
      url: try webSocketURL(
        sessionId: sessionId, afterSeq: afterSeq, truncateResults: truncateResults,
        imageRefs: imageRefs))
    applyAuth(&request)
    if let socketFactory {
      return socketFactory(request, urlSession)
    }
    return URLSessionWebSocketTransport(request: request, urlSession: urlSession)
  }

  // MARK: - Plumbing

  private func applyAuth(_ request: inout URLRequest) {
    guard let authKey, !authKey.isEmpty else { return }
    request.setValue("Bearer \(authKey)", forHTTPHeaderField: "Authorization")
  }

  @discardableResult
  private func call(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws
    -> Data
  {
    var request = URLRequest(url: try makeURL(path))
    request.httpMethod = method
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    applyAuth(&request)
    let (data, response) = try await urlSession.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw Self.error(from: data, status: status, summary: "\(method) \(path)")
    }
    return data
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

  private static func error(from data: Data, status: Int, summary: String) -> WorkerClientError {
    let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
    return WorkerClientError(
      message: message ?? "\(summary) failed with \(status)", statusCode: status)
  }

  // MARK: - Percent encoding

  /// `encodeURIComponent`'s unreserved set — anything else is escaped, so a
  /// session id or profile name containing `/`, `?` or `#` can't break the route.
  private static let componentAllowed = CharacterSet(
    charactersIn:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

  static func encodeComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: componentAllowed) ?? value
  }

  /// Encode a file path per segment, preserving `/` — mirrors `sessionFileUrl`
  /// in the reference client (empty segments are dropped).
  static func encodeFilePath(_ path: String) -> String {
    path.split(separator: "/", omittingEmptySubsequences: true)
      .map { encodeComponent(String($0)) }
      .joined(separator: "/")
  }

  static func encodeQueryValue(_ value: String) -> String {
    encodeComponent(value)
  }
}

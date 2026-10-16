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

  /// List the files in a session's scratch filesystem (deliverables the agent
  /// wrote; see the `file_delivered` event). 404s when the session's engine has
  /// no file store - Claude-engine sessions write to the real disk instead.
  public func listSessionFiles(sessionId: String) async throws -> [SessionFileInfo] {
    let data = try await call("GET", "/sessions/\(Self.encodeComponent(sessionId))/files")
    return try decode(ListSessionFilesResponse.self, from: data).files
  }

  /// Download one session file. Returned as bytes so binary deliverables survive;
  /// decode with `String(decoding:as:)` for text.
  public func fetchSessionFile(sessionId: String, path: String) async throws -> Data {
    try await raw(Self.sessionFilePath(sessionId, path)).0
  }

  /// Direct download URL for a session file. Carries no headers - on an
  /// authenticated server use `fetchSessionFile` instead.
  public func sessionFileURL(sessionId: String, path: String) throws -> URL {
    try makeURL(Self.sessionFilePath(sessionId, path))
  }

  private static func sessionFilePath(_ sessionId: String, _ path: String) -> String {
    "/sessions/\(encodeComponent(sessionId))/files/\(encodeFilePath(path))"
  }

  // MARK: - Attachments

  /// Upload one file for a session, ahead of the message that will carry it.
  /// The returned attachment's `id` goes into the message that carries it.
  ///
  /// The body is the raw bytes - there is no multipart here, which is why this is
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
    let status = UInt16(clamping: (response as? HTTPURLResponse)?.statusCode ?? 0)
    let contentType = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "content-type")
    if let error = restError(status: status, contentType: contentType, body: String(decoding: body, as: UTF8.self)) {
      throw WorkerClientError(error)
    }
    return try decode(UploadAttachmentResponse.self, from: body).attachment
  }

  /// Download an attachment's bytes. Header auth means the phone fetches these
  /// itself rather than pointing an image view at a URL.
  public func fetchAttachment(sessionId: String, attachmentId: String) async throws -> Data {
    try await raw("/sessions/\(Self.encodeComponent(sessionId))/attachments/\(Self.encodeComponent(attachmentId))").0
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

  // MARK: - Shells

  /// Every tracked shell of a session, newest first.
  public func listShells(sessionId: String) async throws -> [ShellInfo] {
    let data = try await call("GET", "/sessions/\(Self.encodeComponent(sessionId))/shells")
    return try decode(ListShellsResponse.self, from: data).shells
  }

  /// One shell's record. **A 404 is an answer, not a malfunction**: the record
  /// was swept past its TTL, or it belongs to a gateway generation this one
  /// cannot speak for. That is what a `running` row's first-render check is for
  /// - the event log's claim may be older than the process.
  public func getShell(sessionId: String, shellId: String) async throws -> ShellInfo {
    let data = try await call(
      "GET",
      "/sessions/\(Self.encodeComponent(sessionId))/shells/\(Self.encodeComponent(shellId))")
    return try decode(ShellResponse.self, from: data).shell
  }

  /// A shell's captured output. `text` is the stripped view a row draws; `raw`
  /// is the PTY bytes a terminal would replay. `tail` bounds it to the last N
  /// bytes, which is what a row expanding a dev server's log wants.
  public func shellOutput(
    sessionId: String, shellId: String, view: ShellOutputView = .text, tail: Int? = nil
  ) async throws -> String {
    var suffix = "?view=\(view.rawValue)"
    if let tail { suffix += "&tail=\(tail)" }
    let (data, _) = try await raw(
      "/sessions/\(Self.encodeComponent(sessionId))/shells/\(Self.encodeComponent(shellId))/output\(suffix)")
    return String(decoding: data, as: UTF8.self)
  }

  // MARK: - SDK sessions

  // An engine's on-disk sessions, for resume across gateway restarts.
  public func listSdkSessions(_ call: HttpCall) async throws -> [SdkSessionSummary] {
    try decode(ListSdkSessionsResponse.self, from: try await perform(call)).sdkSessions
  }

  // MARK: - Host filesystem

  /// The host directories this server will let this client browse, and whether it
  /// accepts writes.
  ///
  /// Throws a 404 `WorkerClientError` when the server has no host-file roots
  /// configured - that is the normal answer, not a malfunction, and the caller
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

  /// Recursive fuzzy file search under one host directory - what backs `@file`
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

  /// Write one host file. A 409 means the file changed since it was read - the
  /// agent edits this same tree, so the edit has to be rebased, never forced.
  @discardableResult
  public func writeHostFile(_ request: WriteHostFileRequest) async throws -> WriteHostFileResponse {
    let data = try await call("PUT", "/fs/write", body: request)
    return try decode(WriteHostFileResponse.self, from: data)
  }

  /// Fetch the bytes of a file this session's ENGINE produced - the `fileId` of
  /// a `file_produced` event (codex's generated images).
  ///
  /// Deliberately not `/fs/read`: this route needs no host-file roots declared
  /// and applies no byte cap, because its allowlist is the exact set of paths
  /// this session's own runner reported writing, not a directory grant. A
  /// generated PNG is routinely megabytes, which is what made the old path
  /// fail by default.
  public func readProducedFile(sessionId: String, fileId: String) async throws -> Data {
    try await raw("/sessions/\(Self.encodeComponent(sessionId))/produced/\(Self.encodeComponent(fileId))").0
  }

  /// The bytes behind a `ProjectIcon.image` - the session-scoped icon route.
  ///
  /// Session-scoped, taking **no path**: the gateway serves whatever its own
  /// discovery resolved for this session's cwd, so the fetch rides the same
  /// gate as every other `/sessions/:id/*` route. Fetched rather than pointed
  /// at, for the reason `fetchAttachment` is: the gateway authenticates with a
  /// header, so an image view aimed at the URL would render a 401.
  ///
  /// Cache the result by `ProjectIcon.image.hash`, never by session: two
  /// sessions in one project serve identical bytes, and the hash is on the
  /// wire precisely so a client fetches once per project.
  ///
  /// A 404 is the uniform "no icon" - no project, a glyph-only project, or an
  /// icon the gateway refused, deliberately indistinguishable (saying which
  /// would say *why* a path was refused). Treat it as "draw no image", never
  /// as an error worth reporting.
  public func projectIcon(sessionId: String) async throws -> Data {
    try await raw("/sessions/\(Self.encodeComponent(sessionId))/project/icon").0
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

  // `durations` is set on the busy strip only: one entry per frame, frames laid out left to right.
  public func agentAvatar(id: String, busy: Bool = false) async throws -> AgentAvatarImage {
    let path = Self.agentPath(id, busy ? "/avatar-busy.png" : "/avatar.png")
    let (data, response) = try await raw(path)
    return AgentAvatarImage(
      data: data, durations: frameDurations(response.value(forHTTPHeaderField: "x-frame-durations")))
  }

  static func agentPath(_ id: String, _ suffix: String = "") -> String {
    "/agents/\(encodeComponent(id))\(suffix)"
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
  /// not JSON - base64 in a payload would double the memory and add a decode on
  /// the main thread for something `UIImage(data:)` already does.
  ///
  /// A 404 means "ask again after a fresh attach": a woken dormant session has a
  /// fresh log with fresh seqs, and the gateway verifies `toolUseId` against the
  /// block rather than serving another call's pixels under the row you are
  /// looking at.
  public func toolResultImage(
    sessionId: String, seq: Int, toolUseId: String, partIndex: Int
  ) async throws -> Data {
    try await raw(resultImagePath(sessionId: sessionId, seq: Int64(seq), toolUseId: toolUseId, partIndex: Int64(partIndex))).0
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

  // A route this client still names itself; R2 and R3 move them into the core.
  @discardableResult
  private func call(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws -> Data {
    let json = try body.map { String(decoding: try JSONEncoder().encode($0), as: UTF8.self) }
    return try await perform(HttpCall(method: method, path: path, body: json))
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

  // MARK: - Percent encoding

  /// `encodeURIComponent`'s unreserved set - anything else is escaped, so a
  /// session id or profile name containing `/`, `?` or `#` can't break the route.
  private static let componentAllowed = CharacterSet(
    charactersIn:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

  static func encodeComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: componentAllowed) ?? value
  }

  /// Encode a file path per segment, preserving `/` - mirrors `sessionFileUrl`
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

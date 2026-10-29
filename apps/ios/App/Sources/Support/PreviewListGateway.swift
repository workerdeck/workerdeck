import Foundation
import Synchronization

final class PreviewListGateway: URLProtocol {
  static let host = "preview-gateway.invalid"
  static let baseURL = "http://\(host):8787"

  private static let state = Mutex<[[String: Any]]>(seed)

  static func install() {
    URLProtocol.registerClass(PreviewListGateway.self)
  }

  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == host }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    let path = request.url?.path ?? ""
    let body = Self.body(of: request)
    let (status, answer) = Self.answer(method: request.httpMethod ?? "GET", path: path, body: body)
    guard let url = request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])
    else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(answer.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  private static func answer(method: String, path: String, body: [String: Any]) -> (Int, String) {
    let parts = path.split(separator: "/").map(String.init)
    let id = parts.count == 3 ? parts[2] : ""
    switch (method, parts.count == 3 ? parts[1] : path) {
    case ("GET", "/v1/sessions"):
      return (200, ListFixture.body(state.withLock { $0 }))
    case ("PATCH", "agents"):
      guard body.keys.contains("lead") else { return (200, "{}") }
      state.withLock { sessions in
        guard let at = sessions.firstIndex(where: { agent(of: $0)?["id"] as? String == id }) else { return }
        place(&sessions, at: at, lead: body["lead"] as? String)
      }
      return (200, "{}")
    case ("PATCH", "sessions"):
      guard let agent = body["agent"] as? [String: Any] else { return (200, "{}") }
      state.withLock { sessions in
        guard let at = sessions.firstIndex(where: { $0["id"] as? String == id }) else { return }
        sessions[at]["agent"] = ["id": "agent-\(id)", "name": "Agent-\(id)"]
        place(&sessions, at: at, lead: agent["lead"] as? String)
      }
      return (200, "{}")
    default:
      return (404, #"{"error":"not found"}"#)
    }
  }

  private static func place(_ sessions: inout [[String: Any]], at: Int, lead: String?) {
    guard var mover = agent(of: sessions[at]) else { return }
    let before = mover["lead"] as? String
    if let lead, let leader = sessions.firstIndex(where: { agent(of: $0)?["id"] as? String == lead }) {
      var target = agent(of: sessions[leader]) ?? [:]
      target["leads"] = true
      sessions[leader]["agent"] = target
      mover["lead"] = lead
      mover["team"] = target["name"]
      mover["order"] = sessions.filter { agent(of: $0)?["lead"] as? String == lead }.count
    } else {
      mover["lead"] = nil
      mover["team"] = nil
      mover["order"] = nil
    }
    sessions[at]["agent"] = mover
    if let before, !sessions.contains(where: { agent(of: $0)?["lead"] as? String == before }),
      let old = sessions.firstIndex(where: { agent(of: $0)?["id"] as? String == before })
    {
      var former = agent(of: sessions[old]) ?? [:]
      former["leads"] = nil
      sessions[old]["agent"] = former
    }
  }

  private static func agent(of session: [String: Any]) -> [String: Any]? { session["agent"] as? [String: Any] }

  // `URLSession` hands a protocol the body as a stream, never as `httpBody`.
  private static func body(of request: URLRequest) -> [String: Any] {
    var data = request.httpBody ?? Data()
    if data.isEmpty, let stream = request.httpBodyStream {
      stream.open()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        guard read > 0 else { break }
        data.append(buffer, count: read)
      }
      stream.close()
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
  }

  private static var seed: [[String: Any]] {
    let ago = Date().timeIntervalSince1970 * 1000 - 6 * 60 * 1000
    func row(_ id: String, _ status: String, _ extra: [String: Any]) -> [String: Any] {
      var fields: [String: Any] = ["model": "claude-opus-5", "lastActivityAt": ago]
      fields.merge(extra) { _, new in new }
      return ListFixture.session(id, status: status, fields)
    }
    return [
      row("lead", "running", ["agent": ["id": "A", "name": "WD-Lead", "leads": true]]),
      row(
        "review", "awaiting_approval",
        ["pendingPermissionCount": 1, "agent": ["id": "B", "name": "WD-Review", "lead": "A", "team": "WD-Lead", "order": 0]]),
      row("codex", "running", ["title": "Codex parity sweep", "engine": "codex", "model": "gpt-6-sol"]),
      row("box", "idle", ["agent": ["id": "E", "name": "BOX-Lead"]]),
      row("docs", "idle", ["agent": ["id": "D", "name": "WD-Docs"]]),
      row("plain", "idle", ["title": "Fix the relay drop"]),
    ]
  }
}

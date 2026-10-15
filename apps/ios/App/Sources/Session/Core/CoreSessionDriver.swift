#if WD_NATIVE_CORE
import Foundation
import OSLog
@preconcurrency import WorkerDeckSession

struct CoreSessionUi: @unchecked Sendable {
  var title: String?
  var connection: WorkerDeckSession.ConnectionState = .connecting
  var error: String?
  var progress: ReplayProgress?
  var rows: [LayoutRow] = []
  var book = CoreHeightBook([])
  var promptRows: [Int] = []
  var recapRow: Int?
  var reveal: TranscriptRevealRequest?
  var startRow = 0
  var lines: [[TranscriptLine]] = []
  var linesRevision = 0
  var pinned: CorePinnedLine?
  var chrome: SessionChrome?
  var modelPicker: ModelPicker?
  var modePicker: ModePicker?
  var prompt: Prompt?
  var planLines: [TranscriptLine] = []
  var openSeconds: Double?

  func linesAt(_ row: Int) -> [TranscriptLine]? {
    let index = row - startRow
    return lines.indices.contains(index) ? lines[index] : nil
  }
}

struct CorePinnedLine {
  let key: String
  let line: TranscriptLine
}

// Android's SessionModel minus the UI state: everything that touches the Session, the socket and `ui` runs on the
// worker's queue, and every change leaves through `publish` as one value.
final class CoreSessionDriver: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  private static let log = Logger(subsystem: "bi.atomic.workerdeck.ios", category: "core-session")

  private let sessionId: String
  private let baseURL: String
  private let apiBase: String
  private let authKey: String?
  private let publish: @Sendable (CoreSessionUi) -> Void
  private let fixture: [String]?
  private let session: Session
  private var worker: SessionWorker!
  private var urlSession: URLSession!
  private let startedAt = ProcessInfo.processInfo.systemUptime

  private var ui = CoreSessionUi()
  private var socket: URLSessionWebSocketTask?

  // Socket callbacks arrive on URLSession's queue, maybe before the worker stored the socket, so each task carries its
  // generation and a callback from a replaced one is dropped by number.
  private let lock = NSLock()
  private var generation = 0

  init(
    sessionId: String, baseURL: String, authKey: String?, metrics: Metrics, hideThinking: Bool,
    fixture: [String]? = nil, publish: @escaping @Sendable (CoreSessionUi) -> Void
  ) {
    self.fixture = fixture
    self.sessionId = sessionId
    self.baseURL = baseURL
    self.apiBase = WorkerDeckSession.apiBase(baseUrl: baseURL)
    self.authKey = authKey?.isEmpty == false ? authKey : nil
    self.publish = publish
    session = Session(afterSeq: 0, reconnect: true, nonce: UUID().uuidString, metrics: metrics)
    super.init()
    urlSession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    worker = SessionWorker(session: session) { [weak self] effects in self?.handle(effects) }
    let now = Date().timeIntervalSince1970 * 1000
    worker.act {
      $0.setWallClock(nowMs: now) + $0.setNavigation(subagents: false, shells: false)
        + $0.setHideThinking(hide: hideThinking) + $0.takeEffects()
    }
  }

  func resize(_ metrics: Metrics) { worker.act { $0.resize(metrics: metrics) } }
  func press(row: Int, line: Int) { worker.act { $0.pressLine(row: UInt32(row), line: UInt32(line)) } }
  func reconnect() { worker.act { $0.reconnectNow() } }
  func send(_ text: String) { worker.act { $0.send(text: text, attachmentIds: []) } }
  func interrupt() { worker.act { $0.interrupt() } }
  func setModel(_ model: String?) { worker.act { $0.setModel(model: model) } }
  func setEffort(_ effort: String?) { worker.act { $0.setEffort(effort: effort) } }
  func setMode(_ mode: Mode) { worker.act { $0.setPermissionMode(mode: mode) } }
  func allow(_ requestId: String) { worker.act { $0.approve(requestId: requestId, updatedInputJson: nil) } }

  func deny(_ requestId: String, message: String?, interrupt: Bool) {
    worker.act { $0.deny(requestId: requestId, message: message, interrupt: interrupt ? true : nil) }
  }

  func answer(_ requestId: String, _ selections: [Selection]) {
    worker.act { $0.answer(requestId: requestId, selections: selections) }
  }

  func dismiss(_ requestId: String) { worker.act { $0.dismissQuestion(requestId: requestId) } }

  func setRecap(boundary: Int, since: Double) {
    worker.act { $0.setRecap(boundary: UInt32(max(0, boundary)), sinceMs: since) }
  }

  // A row's first line for the sticky prompt, read on its own when the row sits outside the held window.
  func pinLine(row: Int) {
    worker.act { [self] session in
      guard ui.rows.indices.contains(row),
        let line = (try? Snapshots.transcriptLines(session.transcriptLines(start: UInt32(row), end: UInt32(row + 1))))?
          .rows.first?.first
      else { return [] }
      ui.pinned = CorePinnedLine(key: ui.rows[row].key, line: line)
      publish(ui)
      return []
    }
  }

  func visible(first: Int, last: Int) {
    worker.act { [self] session in
      if let bytes = session.showRows(first: UInt32(max(0, first)), last: UInt32(max(0, last))) {
        showLines(bytes)
        publish(ui)
      }
      return []
    }
  }

  // The worker drops anything queued after close, so the teardown happens here: invalidating cancels the socket and
  // releases the session's strong hold on this delegate.
  func close() {
    _ = bump()
    worker.close()
    urlSession.invalidateAndCancel()
  }

  private func bump() -> Int {
    lock.lock()
    defer { lock.unlock() }
    generation += 1
    return generation
  }

  private func current(_ task: URLSessionTask) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return task.taskDescription == String(generation)
  }

  private func handle(_ effects: [Effect]) {
    for effect in effects {
      switch effect {
      case .open(let afterSeq): open(afterSeq)
      case .send(let id, let text): sendFrame(id, text)
      case .close:
        _ = bump()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
      case .request(let id, let method, let path, let scoped): request(id, method, path, scoped)
      case .changed(let changed): self.changed(changed)
      case .openShell, .openSubagent, .wakeAt: break
      }
    }
  }

  private func open(_ afterSeq: Int64) {
    if let fixture {
      worker.opened()
      fixture.forEach(worker.received)
      return
    }
    let mine = bump()
    socket?.cancel(with: .goingAway, reason: nil)
    let address = WorkerDeckSession.socketUrl(baseUrl: baseURL, sessionId: sessionId, afterSeq: afterSeq)
    guard let url = URL(string: address) else {
      socket = nil
      worker.act { $0.closed(now: ProcessInfo.processInfo.systemUptime) }
      return
    }
    let task = urlSession.webSocketTask(with: authed(URLRequest(url: url)))
    task.maximumMessageSize = 64 << 20
    task.taskDescription = String(mine)
    socket = task
    receive(task)
    task.resume()
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self, self.current(task) else { return }
      switch result {
      case .success(.string(let text)):
        self.worker.received(text)
        self.receive(task)
      case .success(.data(let data)):
        if let text = String(data: data, encoding: .utf8) { self.worker.received(text) }
        self.receive(task)
      case .success:
        self.receive(task)
      case .failure:
        self.lost(task)
      }
    }
  }

  private func lost(_ task: URLSessionTask) {
    worker.act { [self] session in
      guard socket === task else { return [] }
      socket = nil
      return session.closed(now: ProcessInfo.processInfo.systemUptime)
    }
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?
  ) {
    guard current(webSocketTask) else { return }
    worker.opened()
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    if current(webSocketTask) { lost(webSocketTask) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if task is URLSessionWebSocketTask, current(task) { lost(task) }
  }

  private func sendFrame(_ id: UInt64, _ text: String) {
    guard fixture == nil else {
      worker.act { $0.sendDone(id: id, ok: true) }
      return
    }
    guard let socket else {
      worker.act { $0.sendDone(id: id, ok: false) }
      return
    }
    socket.send(.string(text)) { [weak self] error in
      self?.worker.act { $0.sendDone(id: id, ok: error == nil) }
    }
  }

  private func request(_ id: UInt64, _ method: String, _ path: String, _ scoped: Bool) {
    guard fixture == nil else {
      worker.act { $0.responded(id: id, status: 404, body: "") }
      return
    }
    let encoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? sessionId
    let address = scoped ? "\(apiBase)/sessions/\(encoded)\(path)" : apiBase + path
    guard let url = URL(string: address) else {
      worker.act { $0.responded(id: id, status: 0, body: "") }
      return
    }
    var request = authed(URLRequest(url: url))
    request.httpMethod = method
    if method != "GET" { request.httpBody = Data() }
    urlSession.dataTask(with: request) { [weak self] data, response, _ in
      let status = UInt16(clamping: (response as? HTTPURLResponse)?.statusCode ?? 0)
      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      self?.worker.act { $0.responded(id: id, status: status, body: body) }
    }.resume()
  }

  private func authed(_ request: URLRequest) -> URLRequest {
    var request = request
    if let authKey { request.setValue("Bearer \(authKey)", forHTTPHeaderField: "Authorization") }
    return request
  }

  // Each part is re-read only when the core says it moved: a replay's progress ticks never touch the layout.
  private func changed(_ changed: Changed) {
    if changed.transcript {
      let layout = try? Snapshots.transcriptLayout(session.transcriptLayout())
      ui.rows = layout?.rows ?? []
      ui.book = CoreHeightBook(ui.rows)
      ui.promptRows = ui.rows.indices.filter { ui.rows[$0].prompt }
      ui.recapRow = ui.rows.firstIndex(where: \.recap)
      ui.reveal = layout?.revealRow.map {
        TranscriptRevealRequest(row: $0, nonce: Int(truncatingIfNeeded: layout?.revealNonce ?? 0))
      }
      showLines(session.viewportLines())
    }
    if changed.chrome {
      ui.title = session.sessionTitle()
      ui.connection = session.connection()
      ui.error = session.takeProtocolError() ?? ui.error
      ui.chrome = session.chrome()
      ui.modelPicker = session.modelPicker()
      ui.modePicker = session.modePicker()
    }
    if changed.prompt { ui.prompt = session.prompt() }
    if (changed.prompt || changed.transcript) && ui.prompt?.kind == .plan {
      ui.planLines = (try? Snapshots.transcriptLines(session.promptPlanLines()))?.rows.first ?? []
    }
    if changed.progress || changed.transcript { ui.progress = session.replayProgress() }
    if ui.openSeconds == nil, ui.connection == .live, ui.progress == nil, !ui.rows.isEmpty {
      let seconds = ProcessInfo.processInfo.systemUptime - startedAt
      ui.openSeconds = seconds
      Self.log.notice("session open: \(seconds, format: .fixed(precision: 3)) s, \(self.ui.rows.count) rows")
    }
    publish(ui)
  }

  private func showLines(_ bytes: Data) {
    guard let lines = try? Snapshots.transcriptLines(bytes) else { return }
    ui.startRow = lines.startRow
    ui.lines = lines.rows
    ui.linesRevision &+= 1
  }
}
#endif

import Foundation
import OSLog
@preconcurrency import WorkerDeckSession

// One transcript surface as the core lays it out: the session's own rows, or an open sub-agent frame's.
struct CoreRows: @unchecked Sendable {
  var rows: [LayoutRow] = []
  var book = CoreHeightBook([])
  var promptRows: [Int] = []
  var recapRow: Int?
  var reveal: TranscriptRevealRequest?
  var startRow = 0
  var lines: [[TranscriptLine]] = []
  var linesRevision = 0
  var rail: [ScrubCluster] = []

  func linesAt(_ row: Int) -> [TranscriptLine]? {
    let index = row - startRow
    return lines.indices.contains(index) ? lines[index] : nil
  }

  mutating func lay(_ bytes: Data?) {
    let layout = bytes.flatMap { try? Snapshots.transcriptLayout($0) }
    rows = layout?.rows ?? []
    book = CoreHeightBook(rows)
    promptRows = rows.indices.filter { rows[$0].prompt }
    recapRow = rows.firstIndex(where: \.recap)
    reveal = layout?.revealRow.map {
      TranscriptRevealRequest(row: $0, nonce: Int(truncatingIfNeeded: layout?.revealNonce ?? 0))
    }
  }

  mutating func show(_ bytes: Data?) {
    guard let bytes, let lines = try? Snapshots.transcriptLines(bytes) else { return }
    startRow = lines.startRow
    self.lines = lines.rows
    linesRevision &+= 1
  }
}

struct CoreSessionUi: @unchecked Sendable {
  var title: String?
  var connection: WorkerDeckSession.ConnectionState = .connecting
  var error: String?
  var progress: ReplayProgress?
  var main = CoreRows()
  var pinned: CorePinnedLine?
  var chrome: SessionChrome?
  var modelPicker: ModelPicker?
  var modePicker: ModePicker?
  var prompt: Prompt?
  var planLines: [TranscriptLine] = []
  var openSeconds: Double?
  var canRunShell = false
  var shell: CoreShellState?
  var frame: CoreFrameState?
  var peek: CoreRailPeek?
  var focus: TranscriptFocusRequest?
  var seen: CoreSeen?
  var usage: SessionUsageView?
}

// What a read mark records once the replay settled: the items on screen and the attach snapshot's rollup counters.
struct CoreSeen: Equatable, Sendable {
  var itemCount: Int
  var activity: Int?
  var prose: Int?
  var turns: Int?
}

// Where a session opens besides its tail. Held until the replay settles, so it lands on a transcript that has the thing.
enum CoreEntry: Sendable {
  case seq(Int, epoch: Int?)
  case reveal(String)
  case subagent(String)
  case shell(String)
}

// The open sub-agent takeover: one agent's own rows, read through the core's frame window.
struct CoreFrameState: @unchecked Sendable {
  let taskId: String
  var strip: FrameStrip?
  var rows = CoreRows()
}

struct CoreRailPeek: @unchecked Sendable {
  let inFrame: Bool
  let y: Double
  let peek: ScrubPeek
}

struct CoreRailSize: Equatable {
  let railH: Double
  let viewportH: Double
}

// The open shell screen. `sized` turns true once the screen measured itself and attached, so a grid is read only after.
struct CoreShellState: Equatable {
  let id: String
  var sized = false
  var grid: ShellGrid?
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
  private var railSize: CoreRailSize?
  private var frameRailSize: CoreRailSize?
  private var pending: CoreEntry?

  // Socket callbacks arrive on URLSession's queue, maybe before the worker stored the socket, so each task carries its
  // generation and a callback from a replaced one is dropped by number.
  private let lock = NSLock()
  private var generation = 0
  private var usagePoll: Task<Void, Never>?

  init(
    sessionId: String, baseURL: String, authKey: String?, metrics: Metrics, hideThinking: Bool,
    fixture: [String]? = nil, entry: CoreEntry? = nil, publish: @escaping @Sendable (CoreSessionUi) -> Void
  ) {
    self.fixture = fixture
    pending = entry
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
      $0.setWallClock(nowMs: now) + $0.setNavigation(subagents: true, shells: true)
        + $0.setHideThinking(hide: hideThinking) + $0.takeEffects()
    }
  }

  func resize(_ metrics: Metrics) { worker.act { $0.resize(metrics: metrics) } }
  func press(row: Int, line: Int) { worker.act { $0.pressLine(row: UInt32(row), line: UInt32(line)) } }
  func reconnect() { worker.act { $0.reconnectNow() } }
  func send(_ text: String) { worker.act { $0.send(text: text, attachmentIds: []) } }
  func runShell(_ command: String) { worker.act { $0.runShell(command: command) } }
  func interrupt() { worker.act { $0.interrupt() } }
  func clearContext() { worker.act { $0.clearContext() } }
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
      guard ui.main.rows.indices.contains(row),
        let line = (try? Snapshots.transcriptLines(session.transcriptLines(start: UInt32(row), end: UInt32(row + 1))))?
          .rows.first?.first
      else { return [] }
      ui.pinned = CorePinnedLine(key: ui.main.rows[row].key, line: line)
      publish(ui)
      return []
    }
  }

  func visible(first: Int, last: Int) {
    worker.act { [self] session in
      if let bytes = session.showRows(first: UInt32(max(0, first)), last: UInt32(max(0, last))) {
        ui.main.show(bytes)
        publish(ui)
      }
      return []
    }
  }

  func openFrame(_ taskId: String) {
    worker.act { [self] session in
      if ui.frame?.taskId != taskId {
        ui.frame = CoreFrameState(taskId: taskId)
        frameRailSize = nil
      }
      let effects = session.openFrame(taskId: taskId)
      readFrame()
      publish(ui)
      return effects
    }
  }

  func closeFrame(_ taskId: String) {
    worker.act { [self] session in
      if ui.frame?.taskId == taskId {
        ui.frame = nil
        frameRailSize = nil
        if ui.peek?.inFrame == true { ui.peek = nil }
        publish(ui)
      }
      return session.closeFrame(taskId: taskId)
    }
  }

  func framePress(row: Int, line: Int) {
    worker.act { [self] session in
      guard let taskId = ui.frame?.taskId else { return [] }
      return session.framePressLine(taskId: taskId, row: UInt32(row), line: UInt32(line))
    }
  }

  func frameVisible(first: Int, last: Int) {
    worker.act { [self] session in
      guard let taskId = ui.frame?.taskId,
        let bytes = session.frameShowRows(
          taskId: taskId, first: UInt32(max(0, first)), last: UInt32(max(0, last)))
      else { return [] }
      ui.frame?.rows.show(bytes)
      publish(ui)
      return []
    }
  }

  // The rail's size in layout points; its clusters follow from it and the transcript.
  func railSize(railH: Double, viewportH: Double, inFrame: Bool) {
    worker.act { [self] _ in
      let size = CoreRailSize(railH: railH, viewportH: viewportH)
      if inFrame {
        guard frameRailSize != size else { return [] }
        frameRailSize = size
        readFrame()
      } else {
        guard railSize != size else { return [] }
        railSize = size
        readRail()
      }
      publish(ui)
      return []
    }
  }

  // What the finger is over on a rail, or nil once it lifts.
  func peek(_ cluster: ScrubCluster?, y: Double, inFrame: Bool) {
    worker.act { [self] session in
      let taskId = inFrame ? ui.frame?.taskId : nil
      if inFrame && taskId == nil { return [] }
      ui.peek = cluster.flatMap { session.scrubberPeek(taskId: taskId, cluster: $0, y: y) }.map {
        CoreRailPeek(inFrame: inFrame, y: y, peek: $0)
      }
      publish(ui)
      return []
    }
  }

  func openShell(_ id: String, cols: Int, rows: Int) {
    worker.act { [self] session in
      ui.shell = CoreShellState(id: id, sized: true, grid: ui.shell?.id == id ? ui.shell?.grid : nil)
      let effects = session.openShell(shellId: id, shellJson: nil, cols: UInt32(cols), rows: UInt32(rows))
      readShell()
      publish(ui)
      return effects
    }
  }

  func resizeShell(_ id: String, cols: Int, rows: Int) {
    worker.act { [self] session in
      let effects = session.shellResize(shellId: id, cols: UInt32(cols), rows: UInt32(rows))
      readShell()
      publish(ui)
      return effects
    }
  }

  func scrollShell(_ lines: Int) {
    worker.act { [self] session in
      guard let id = ui.shell?.id else { return [] }
      let effects = session.shellScroll(shellId: id, lines: Int32(clamping: lines))
      readShell()
      publish(ui)
      return effects
    }
  }

  func shellKey(_ id: String, _ key: Key) { worker.act { $0.shellKey(shellId: id, key: key) } }
  func shellText(_ id: String, _ text: String) { worker.act { $0.shellText(shellId: id, text: text) } }
  func shellPaste(_ id: String, _ text: String) { worker.act { $0.shellPaste(shellId: id, text: text) } }
  func killShell(_ id: String) { worker.act { $0.killShell(shellId: id) } }

  func closeShell(_ id: String) {
    worker.act { [self] session in
      guard ui.shell?.id == id else { return session.closeShell(shellId: id) }
      ui.shell = nil
      publish(ui)
      return session.closeShell(shellId: id)
    }
  }

  // The worker drops anything queued after close, so the teardown happens here: invalidating cancels the socket and
  // releases the session's strong hold on this delegate.
  func close() {
    _ = bump()
    lock.lock()
    usagePoll?.cancel()
    usagePoll = nil
    lock.unlock()
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
      case .openShell(let id):
        guard ui.shell?.id != id else { break }
        ui.shell = CoreShellState(id: id)
        publish(ui)
      case .openSubagent(let taskId): openFrame(taskId)
      case .wakeAt: break
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
    if fixture != nil {
      worker.act { $0.sendDone(id: id, ok: true) }
      CoreReplayFixture.replies(to: text).forEach(worker.received)
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
    if fixture != nil {
      let (status, body) = CoreReplayFixture.respond(method, path)
      worker.act { $0.responded(id: id, status: status, body: body) }
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
      ui.main.lay(session.transcriptLayout())
      ui.main.show(session.viewportLines())
    }
    if changed.chrome {
      ui.title = session.sessionTitle()
      ui.connection = session.connection()
      ui.error = session.takeProtocolError() ?? ui.error
      ui.chrome = session.chrome()
      ui.modelPicker = session.modelPicker()
      ui.modePicker = session.modePicker()
      ui.canRunShell = session.canRunShell()
      readUsage()
    }
    if changed.prompt { ui.prompt = session.prompt() }
    if (changed.prompt || changed.transcript) && ui.prompt?.kind == .plan {
      ui.planLines = (try? Snapshots.transcriptLines(session.promptPlanLines()))?.rows.first ?? []
    }
    if changed.progress || changed.transcript { ui.progress = session.replayProgress() }
    if changed.shells { readShell() }
    if changed.transcript || changed.prompt { readRail() }
    if changed.frames || changed.transcript || changed.prompt { readFrame() }
    if ui.openSeconds == nil, ui.connection == .live, ui.progress == nil, !ui.main.rows.isEmpty {
      let seconds = ProcessInfo.processInfo.systemUptime - startedAt
      ui.openSeconds = seconds
      Self.log.notice("session open: \(seconds, format: .fixed(precision: 3)) s, \(self.ui.main.rows.count) rows")
    }
    if ui.connection == .live, ui.progress == nil {
      if changed.transcript || changed.chrome || ui.seen == nil { ui.seen = readSeen() }
      if pending != nil, !ui.main.rows.isEmpty { enter() }
    }
    publish(ui)
  }

  private func enter() {
    guard let entry = pending else { return }
    pending = nil
    switch entry {
    case .seq(let seq, let epoch):
      // A dormant wake renumbers the log, so a seq from another epoch is not the row it names.
      guard (epoch ?? 0) == (sessionEpoch() ?? 0),
        let item = session.itemForSeq(seq: Int64(seq))
      else { return }
      focus(row: Int(session.rowForItem(item: item)))
    case .reveal(let toolUseId):
      if let row = session.rowForToolCall(toolUseId: toolUseId) { focus(row: Int(row)) }
    case .subagent(let taskId):
      openFrame(taskId)
    case .shell(let id):
      if ui.shell == nil { ui.shell = CoreShellState(id: id) }
    }
  }

  private func focus(row: Int) {
    ui.focus = TranscriptFocusRequest(row: row, nonce: (ui.focus?.nonce ?? 0) &+ 1, complete: true)
  }

  private func sessionInfo() -> [String: Any]? {
    guard let json = session.sessionInfoJson(), let data = json.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  private func sessionEpoch() -> Int? { (sessionInfo()?["epoch"] as? NSNumber)?.intValue }

  // Nil before the attach: a session opened over a dead link was never seen, and a zero mark would turn its whole
  // history unread.
  private func readSeen() -> CoreSeen? {
    guard let info = sessionInfo() else { return nil }
    let count = { (key: String) in (info[key] as? NSNumber)?.intValue }
    return CoreSeen(
      itemCount: Int(session.itemCount()), activity: count("activityCount"), prose: count("proseCount"),
      turns: count("numTurns"))
  }

  // The meters, re-read whenever the core flags the chrome; the first reading that names a profile with plan windows
  // starts the account poll.
  private func readUsage() {
    let usage = session.usage(nowMs: Date().timeIntervalSince1970 * 1000)
    ui.usage = usage
    guard let profile = usage.profile, usage.rateLimits else { return }
    startUsagePoll(profile: profile)
  }

  // `GET /v1/profiles` on the dashboard's 60 s cadence, seeded from the last body any session on this gateway read, so
  // a session switch does not draw its own replayed numbers for a whole round trip. A 404 is a gateway that predates
  // profiles: stop asking.
  private func startUsagePoll(profile: String) {
    lock.lock()
    defer { lock.unlock() }
    guard usagePoll == nil else { return }
    if let cached = CoreProfilesCache.shared.body(for: apiBase), session.setProfiles(body: cached) {
      ui.usage = session.usage(nowMs: Date().timeIntervalSince1970 * 1000)
    }
    usagePoll = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, await self.pollProfiles() else { return }
        try? await Task.sleep(for: .seconds(60))
      }
    }
  }

  private func pollProfiles() async -> Bool {
    let status: UInt16
    let body: String
    if fixture != nil {
      (status, body) = CoreReplayFixture.respond("GET", "/profiles")
    } else {
      guard let url = URL(string: apiBase + "/profiles"),
        let (data, response) = try? await urlSession.data(for: authed(URLRequest(url: url)))
      else { return true }
      status = UInt16(clamping: (response as? HTTPURLResponse)?.statusCode ?? 0)
      body = String(decoding: data, as: UTF8.self)
    }
    if status == 404 { return false }
    guard (200..<300).contains(status) else { return true }
    CoreProfilesCache.shared.set(body, for: apiBase)
    worker.act { [self] session in
      guard session.setProfiles(body: body) else { return [] }
      ui.usage = session.usage(nowMs: Date().timeIntervalSince1970 * 1000)
      publish(ui)
      return []
    }
    return true
  }

  private func readShell() {
    guard let shell = ui.shell, shell.sized else { return }
    ui.shell?.grid = session.shellWindow(shellId: shell.id).flatMap { try? Snapshots.shellGrid($0) }
  }

  private func readRail() {
    guard let size = railSize else { return }
    ui.main.rail = session.scrubber(bookmarks: [], railH: size.railH, viewportH: size.viewportH)
  }

  // Within a worker turn the core's frame is always open when `ui.frame` is, so a missing layout means the task left.
  private func readFrame() {
    guard let taskId = ui.frame?.taskId, let layout = session.frameLayout(taskId: taskId) else { return }
    var rows = ui.frame?.rows ?? CoreRows()
    rows.lay(layout)
    rows.show(session.frameViewportLines(taskId: taskId))
    rows.rail =
      frameRailSize.flatMap {
        session.frameScrubber(taskId: taskId, railH: $0.railH, viewportH: $0.viewportH)
      } ?? []
    ui.frame?.strip = session.frameStrip(taskId: taskId)
    ui.frame?.rows = rows
  }
}

// The last `GET /v1/profiles` body per gateway, shared by every session screen.
final class CoreProfilesCache: @unchecked Sendable {
  static let shared = CoreProfilesCache()
  private let lock = NSLock()
  private var bodies: [String: String] = [:]

  func body(for apiBase: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return bodies[apiBase]
  }

  func set(_ body: String, for apiBase: String) {
    lock.lock()
    defer { lock.unlock() }
    bodies[apiBase] = body
  }
}

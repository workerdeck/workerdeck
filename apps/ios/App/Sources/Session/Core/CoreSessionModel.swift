import Foundation
import Observation
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

@MainActor
@Observable
final class CoreSessionModel {
  let sessionId: String
  private(set) var ui = CoreSessionUi()
  var skills: [SkillInfo] { ui.composer.skills }
  var skillSections: [SkillSection] { ui.composer.skillSections }
  var insertion: String?
  private let baseURL: String
  private let authKey: String?
  private let fixture: [String]?
  private var driver: CoreSessionDriver?
  private(set) var metrics: TerminalMetrics?
  private var recap: CatchUpMark?
  private var pinRequested: String?
  private var entry: CoreEntry?

  init(sessionId: String, baseURL: String, authKey: String?, fixture: [String]? = nil, entry: CoreEntry? = nil) {
    self.fixture = fixture
    self.entry = entry
    self.sessionId = sessionId
    self.baseURL = baseURL
    self.authKey = authKey
  }

  // The first width starts the session: the core plans rows for a width, so it cannot attach before it has one.
  func layout(metrics: TerminalMetrics, hideThinking: Bool) {
    guard metrics.width > 0, metrics != self.metrics else { return }
    self.metrics = metrics
    let core = Metrics(
      cell: Double(metrics.cell), line: Double(metrics.line), width: Double(metrics.width),
      fontSize: Double(metrics.fontSize))
    if let driver {
      driver.resize(core)
      return
    }
    let driver = CoreSessionDriver(
      sessionId: sessionId, baseURL: baseURL, authKey: authKey, metrics: core, hideThinking: hideThinking,
      fixture: fixture, entry: entry
    ) { [weak self] ui in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.ui = ui } }
    }
    if let recap { driver.setRecap(boundary: recap.itemCount, since: recap.seenAt) }
    if !bookmarkIds.isEmpty { driver.setBookmarks(bookmarkIds) }
    self.driver = driver
    entry = nil
  }

  func setRecap(_ mark: CatchUpMark) {
    recap = mark
    driver?.setRecap(boundary: mark.itemCount, since: mark.seenAt)
  }

  func clearRecap() {
    recap = nil
    driver?.clearRecap()
  }

  private var bookmarkIds: [String] = []

  func setBookmarks(_ ids: [String]) {
    bookmarkIds = ids
    driver?.setBookmarks(ids)
  }

  func rowMenu(row: Int, inFrame: Bool) -> RowMenu? {
    driver?.rowMenu(row: row, taskId: inFrame ? ui.frame?.taskId : nil)
  }

  func hostImage(_ path: String) -> HostImageFetch? { driver?.hostImage(path) }
  func backgroundTask(_ toolUseId: String) { driver?.backgroundTask(toolUseId) }
  func sleep() { driver?.sleep() }
  func dismissError() { driver?.dismissError() }

  func visible(first: Int, last: Int) { driver?.visible(first: first, last: last) }

  func pinLine(row: Int, key: String) {
    guard pinRequested != key else { return }
    pinRequested = key
    driver?.pinLine(row: row)
  }

  func press(row: Int, line: Int) { driver?.press(row: row, line: line) }
  func openFrame(_ taskId: String) { driver?.openFrame(taskId) }
  func closeFrame(_ taskId: String) { driver?.closeFrame(taskId) }
  func framePress(row: Int, line: Int) { driver?.framePress(row: row, line: line) }
  func frameVisible(first: Int, last: Int) { driver?.frameVisible(first: first, last: last) }

  func railSize(railH: Double, viewportH: Double, inFrame: Bool) {
    driver?.railSize(railH: railH, viewportH: viewportH, inFrame: inFrame)
  }

  func peek(_ cluster: ScrubCluster?, y: Double, inFrame: Bool) { driver?.peek(cluster, y: y, inFrame: inFrame) }
  func openShell(_ id: String, cols: Int, rows: Int) { driver?.openShell(id, cols: cols, rows: rows) }
  func resizeShell(_ id: String, cols: Int, rows: Int) { driver?.resizeShell(id, cols: cols, rows: rows) }
  func scrollShell(_ lines: Int) { driver?.scrollShell(lines) }
  func shellKey(_ id: String, _ key: Key) { driver?.shellKey(id, key) }
  func shellText(_ id: String, _ text: String) { driver?.shellText(id, text) }
  func shellPaste(_ id: String, _ text: String) { driver?.shellPaste(id, text) }
  func killShell(_ id: String) { driver?.killShell(id) }
  func closeShell(_ id: String) { driver?.closeShell(id) }
  func reconnect() { driver?.reconnect() }
  func interrupt() { driver?.interrupt() }
  func clearContext() { driver?.clearContext() }
  func setModel(_ model: String?) { driver?.setModel(model) }
  func setEffort(_ effort: String?) { driver?.setEffort(effort) }
  func setMode(_ mode: Mode) { driver?.setMode(mode) }
  func allow(_ requestId: String) { driver?.allow(requestId) }

  func deny(_ requestId: String, message: String?, interrupt: Bool) {
    driver?.deny(requestId, message: message, interrupt: interrupt)
  }

  func answer(_ requestId: String, _ selections: [Selection]) { driver?.answer(requestId, selections) }
  func dismiss(_ requestId: String) { driver?.dismiss(requestId) }

  func send(_ text: String, attachmentIds: [String] = []) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty || !attachmentIds.isEmpty else { return }
    driver?.send(trimmed, attachmentIds: attachmentIds)
  }

  func backgroundTask() { driver?.backgroundTask() }

  func runShell(_ command: String) {
    let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    driver?.runShell(trimmed)
  }

  // A session left from its shell screen never saw its own disappear close it.
  isolated deinit { driver?.close() }

  func close() {
    driver?.close()
    driver = nil
    metrics = nil
    pinRequested = nil
  }
}

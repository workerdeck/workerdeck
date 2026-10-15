#if WD_NATIVE_CORE
import Foundation
import Observation
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

@MainActor
@Observable
final class CoreSessionModel {
  let sessionId: String
  private(set) var ui = CoreSessionUi()
  private let baseURL: String
  private let authKey: String?
  private let fixture: [String]?
  private var driver: CoreSessionDriver?
  private(set) var metrics: TerminalMetrics?
  private var recap: CatchUpMark?
  private var pinRequested: String?

  init(sessionId: String, baseURL: String, authKey: String?, fixture: [String]? = nil) {
    self.fixture = fixture
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
      fixture: fixture
    ) { [weak self] ui in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.ui = ui } }
    }
    if let recap { driver.setRecap(boundary: recap.itemCount, since: recap.seenAt) }
    self.driver = driver
  }

  func setRecap(_ mark: CatchUpMark) {
    recap = mark
    driver?.setRecap(boundary: mark.itemCount, since: mark.seenAt)
  }

  func visible(first: Int, last: Int) { driver?.visible(first: first, last: last) }

  func pinLine(row: Int, key: String) {
    guard pinRequested != key else { return }
    pinRequested = key
    driver?.pinLine(row: row)
  }

  func press(row: Int, line: Int) { driver?.press(row: row, line: line) }
  func reconnect() { driver?.reconnect() }
  func interrupt() { driver?.interrupt() }
  func setModel(_ model: String?) { driver?.setModel(model) }
  func setEffort(_ effort: String?) { driver?.setEffort(effort) }
  func setMode(_ mode: Mode) { driver?.setMode(mode) }
  func allow(_ requestId: String) { driver?.allow(requestId) }

  func deny(_ requestId: String, message: String?, interrupt: Bool) {
    driver?.deny(requestId, message: message, interrupt: interrupt)
  }

  func answer(_ requestId: String, _ selections: [Selection]) { driver?.answer(requestId, selections) }
  func dismiss(_ requestId: String) { driver?.dismiss(requestId) }

  func send(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    driver?.send(trimmed)
  }

  func close() {
    driver?.close()
    driver = nil
    metrics = nil
    pinRequested = nil
  }
}
#endif

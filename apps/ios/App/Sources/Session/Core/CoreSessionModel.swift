#if WD_NATIVE_CORE
import Foundation
import Observation
@preconcurrency import WorkerDeckSession

@MainActor
@Observable
final class CoreSessionModel {
  let sessionId: String
  private(set) var ui = CoreSessionUi()
  private let baseURL: String
  private let authKey: String?
  private var driver: CoreSessionDriver?
  private var width: Double = 0
  private var shown: Set<Int> = []
  private var visibleQueued = false

  init(sessionId: String, baseURL: String, authKey: String?) {
    self.sessionId = sessionId
    self.baseURL = baseURL
    self.authKey = authKey
  }

  // The first width starts the session: the core plans rows for a width, so it cannot attach before it has one.
  func layout(width: Double, hideThinking: Bool) {
    guard width > 0, width != self.width else { return }
    self.width = width
    let metrics = Self.metrics(width: width)
    if let driver {
      driver.resize(metrics)
      return
    }
    driver = CoreSessionDriver(
      sessionId: sessionId, baseURL: baseURL, authKey: authKey, metrics: metrics, hideThinking: hideThinking
    ) { [weak self] ui in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.ui = ui } }
    }
  }

  func rowShown(_ row: Int, _ on: Bool) {
    if on { shown.insert(row) } else { shown.remove(row) }
    guard !visibleQueued else { return }
    visibleQueued = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      visibleQueued = false
      guard let first = shown.min(), let last = shown.max() else { return }
      driver?.visible(first: first, last: last)
    }
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
    width = 0
  }

  static func metrics(width: Double) -> Metrics {
    let type = TerminalTypography.session
    return Metrics(
      cell: Double(type.cell), line: Double(type.line), width: floor(width), fontSize: Double(type.fontSize))
  }
}
#endif

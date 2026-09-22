import Foundation
import Observation
import WorkerDeckKit

/// What the session's event loop hands a drill-in. Implemented by
/// ``ShellTerminalModel`` and held weakly by ``TranscriptViewModel``, so a
/// popped screen stops receiving without either side having to unregister on
/// exactly the right frame.
@MainActor
protocol ShellStreamSink: AnyObject {
  func shellAttached(_ frame: ShellAttachedFrame)
  func shellOutput(_ data: String)
  func shellDetached(reason: String)
  /// The socket came back. An attach is per socket, so the stream is gone and
  /// the model has to ask for it again at whatever size the pane is now.
  func shellReconnected()
}

/// One open shell, as a screen: the emulator, what is known about the record,
/// and the two directions of the PTY.
///
/// **The bytes never touch the transcript.** They arrive as `shell_output`
/// frames, go into ``VTScreen``, and what a view reads back is a grid. That is
/// the whole reason this is a model of its own rather than more state on
/// `TranscriptViewModel`: a `yes` in a PTY produces bytes faster than SwiftUI
/// can lay out a list, and the only safe place for them is a buffer that
/// overwrites itself.
@MainActor
@Observable
final class ShellTerminalModel: ShellStreamSink, Hashable {
  enum Phase: Equatable {
    case connecting
    case live
    /// The stream ended. `reason` is the gateway's fixed string, shown as-is
    /// only when the record cannot say something better.
    case ended(reason: String)
  }

  let shellId: String
  private(set) var shell: ShellInfo?
  private(set) var phase: Phase = .connecting
  /// Bumped when the grid has changed and a redraw is owed. Coalesced: see
  /// ``markDirty()``.
  private(set) var revision = 0

  /// Deliberately not `@Observable`-tracked. The view reads it every draw but
  /// must redraw on ``revision`` alone, and an observed grid would invalidate
  /// the view once per cell touched.
  @ObservationIgnored let screen: VTScreen
  @ObservationIgnored private weak var session: TranscriptViewModel?
  @ObservationIgnored private var cols: Int
  @ObservationIgnored private var rows: Int
  @ObservationIgnored private var flush: Task<Void, Never>?
  @ObservationIgnored private var attached = false

  /// How long output is allowed to pile up before the grid is redrawn. A frame
  /// at 30Hz: fast enough to read a compiler's progress, slow enough that a
  /// `yes` costs 30 layouts a second instead of thousands.
  private static let flushInterval = Duration.milliseconds(33)

  init(shellId: String, shell: ShellInfo?, session: TranscriptViewModel, cols: Int, rows: Int) {
    self.shellId = shellId
    self.shell = shell
    self.session = session
    self.cols = max(cols, 20)
    self.rows = max(rows, 4)
    screen = VTScreen(cols: self.cols, rows: self.rows)
  }

  // `navigationDestination(item:)` keys the push on the value, and for a model
  // the value is its identity: one open drill-in is one object, and pushing the
  // same one twice is the same screen.
  nonisolated static func == (lhs: ShellTerminalModel, rhs: ShellTerminalModel) -> Bool {
    lhs === rhs
  }

  nonisolated func hash(into hasher: inout Hasher) {
    hasher.combine(ObjectIdentifier(self))
  }

  /// The **record** says the process is alive. Not the same as being able to
  /// type at it: a stream dropped for backpressure leaves a running shell this
  /// screen is no longer watching, and echoing keystrokes into a terminal that
  /// cannot show their effect would be worse than refusing them.
  var isRunning: Bool { shell?.status == .running }

  /// Input may flow: the record is alive **and** the stream is up.
  var canType: Bool { isRunning && phase == .live }

  /// The title line: `#3 npm run dev`, the same reading every other client
  /// gives the same record.
  var title: String { shell.map(TerminalShell.title) ?? "Shell" }

  var statusText: String {
    if let shell, shell.status == .exited { return TerminalShell.statusText(shell) }
    switch phase {
    case .connecting: return "connecting…"
    case .live: return "running"
    case .ended(let reason): return reason
    }
  }

  // MARK: - Lifecycle

  func start() {
    guard !attached else { return }
    attached = true
    session?.attachShell(shellId, sink: self, cols: cols, rows: rows)
  }

  /// Leaving the screen. Stops the stream and **never the process**: a shell
  /// outlives the view that watched it, which is the entire point of the
  /// record.
  func stop() {
    flush?.cancel()
    flush = nil
    attached = false
    session?.detachShell(shellId)
  }

  func kill() {
    session?.killShell(shellId: shellId)
  }

  // MARK: - Size

  /// Tell the gateway the pane's size. Called from a layout pass, so it must be
  /// cheap and idempotent: an unchanged size sends nothing, because every
  /// resize reaches the process as SIGWINCH and a redrawing TUI pays for each.
  func resize(cols: Int, rows: Int) {
    let cols = max(cols, 20)
    let rows = max(rows, 4)
    guard cols != self.cols || rows != self.rows else { return }
    self.cols = cols
    self.rows = rows
    screen.resize(cols: cols, rows: rows)
    markDirty()
    guard attached else { return }
    session?.resizeShell(shellId, cols: cols, rows: rows)
  }

  // MARK: - Input

  func send(_ key: VTKey) {
    guard canType else { return }
    write(screen.encode(key))
  }

  func send(text: String) {
    guard canType else { return }
    write(text)
  }

  func paste(_ text: String) {
    guard canType else { return }
    write(screen.encodePaste(text))
  }

  private func write(_ data: String) {
    guard !data.isEmpty else { return }
    session?.writeShell(shellId, data)
  }

  // MARK: - ShellStreamSink

  func shellAttached(_ frame: ShellAttachedFrame) {
    shell = frame.shell
    phase = frame.shell.status == .running ? .live : .ended(reason: "ended")
    // The size the gateway settled on, which is the size this attach asked for
    // unless another client attached in the same breath. Either way the grid
    // must match the process, or every wrap lands in the wrong column.
    screen.resize(cols: frame.cols, rows: frame.rows)
    cols = frame.cols
    rows = frame.rows
    screen.feed(frame.scrollback)
    drainResponses()
    markDirty()
  }

  func shellOutput(_ data: String) {
    screen.feed(data)
    drainResponses()
    markDirty()
  }

  func shellDetached(reason: String) {
    attached = false
    phase = .ended(reason: reason)
    markDirty()
    // The record is the authority on *why*; the reason is only how this socket
    // found out, and the two are not the same fact. "exit 1" and "we were
    // dropped for backpressure" read very differently, and without this the
    // screen would also keep offering a Kill for a process that had ended.
    session?.verifyShell(shellId)
    Task { [weak self] in
      guard let self, let record = await self.session?.shellRecord(self.shellId) else { return }
      self.shell = record
      self.markDirty()
    }
  }

  func shellReconnected() {
    guard attached else { return }
    session?.attachShell(shellId, sink: self, cols: cols, rows: rows)
  }

  /// A program asked the terminal to report something (cursor position, device
  /// attributes). The answer is typed back into the PTY as if the user had
  /// typed it, which is what it is.
  private func drainResponses() {
    let response = screen.takeResponses()
    guard !response.isEmpty else { return }
    session?.writeShell(shellId, response)
  }

  /// Coalesce the redraw. Output arrives in whatever chunks the socket delivers
  /// and a build can produce hundreds a second; one bump per chunk would make
  /// the frame rate a function of the process's verbosity.
  private func markDirty() {
    guard flush == nil else { return }
    flush = Task { [weak self] in
      try? await Task.sleep(for: Self.flushInterval)
      guard let self, !Task.isCancelled else { return }
      self.flush = nil
      self.revision &+= 1
    }
  }
}

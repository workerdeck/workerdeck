import Foundation
import WorkerDeckCore

// One serial queue owns the Session (docs/NATIVE-CORE-SNAPSHOTS.md § Calling pattern), as Android's SessionWorker.
// Socket callbacks land on any thread; frames that pile up while the session is busy cross in one `receivedBatch`, and
// `WakeAt` is served here, so a host only sees the effects it has to act on, on the session queue. After `close()`
// every entry point is a no-op. Unlike Kotlin, a panic in the core is not catchable from Swift (non-throwing UniFFI
// calls `try!`), so there is no failure callback.
public final class SessionWorker: @unchecked Sendable {
  private let session: Session
  private let clock: @Sendable () -> Double
  private let onEffects: @Sendable ([Effect]) -> Void
  private let queue = DispatchQueue(label: "wd-session")
  private let lock = NSLock()
  private var inbox: [String] = []
  private var drainQueued = false
  private var isClosed = false
  private var wake: DispatchWorkItem?
  // Seconds spent in the core's frame calls and in the host's effect handling; read on the session queue only.
  public private(set) var coreSeconds = 0.0
  public private(set) var hostSeconds = 0.0

  public init(
    session: Session,
    clock: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime },
    onEffects: @escaping @Sendable ([Effect]) -> Void
  ) {
    self.session = session
    self.clock = clock
    self.onEffects = onEffects
  }

  public func received(_ frame: String) {
    lock.lock()
    guard !isClosed else { return lock.unlock() }
    inbox.append(frame)
    let post = !drainQueued
    drainQueued = true
    lock.unlock()
    if post { queue.async { self.drain() } }
  }

  public func opened() { act { $0.opened() } }

  public func closed() { act { [clock] in $0.closed(now: clock()) } }

  public func act(_ command: @escaping @Sendable (Session) -> [Effect]) {
    guard !closedNow() else { return }
    queue.async {
      guard !self.closedNow() else { return }
      self.deliver(command(self.session))
    }
  }

  public func read<T>(_ query: (Session) -> T) -> T {
    queue.sync { query(session) }
  }

  public func close() {
    lock.lock()
    guard !isClosed else { return lock.unlock() }
    isClosed = true
    inbox.removeAll()
    lock.unlock()
    queue.async { self.wake?.cancel() }
  }

  private func closedNow() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return isClosed
  }

  private func drain() {
    lock.lock()
    let frames = inbox
    inbox.removeAll()
    drainQueued = false
    lock.unlock()
    var batch: [String] = []
    for frame in frames {
      if frame.contains("\n") {
        flush(&batch)
        let started = ProcessInfo.processInfo.systemUptime
        let effects = session.received(text: frame, now: clock())
        coreSeconds += ProcessInfo.processInfo.systemUptime - started
        deliver(effects)
      } else {
        batch.append(frame)
      }
    }
    flush(&batch)
  }

  private func flush(_ batch: inout [String]) {
    guard !batch.isEmpty, !closedNow() else { return }
    let started = ProcessInfo.processInfo.systemUptime
    let effects = session.receivedBatch(frames: batch.joined(separator: "\n"), now: clock())
    coreSeconds += ProcessInfo.processInfo.systemUptime - started
    batch.removeAll()
    deliver(effects)
  }

  private func deliver(_ effects: [Effect]) {
    guard !closedNow() else { return }
    var rest: [Effect] = []
    for effect in effects {
      if case .wakeAt(let at) = effect {
        schedule(at)
      } else {
        rest.append(effect)
      }
    }
    guard !rest.isEmpty else { return }
    let started = ProcessInfo.processInfo.systemUptime
    onEffects(rest)
    hostSeconds += ProcessInfo.processInfo.systemUptime - started
  }

  private func schedule(_ at: Double) {
    wake?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self, !self.closedNow() else { return }
      self.deliver(self.session.tick(now: self.clock()))
    }
    wake = item
    queue.asyncAfter(deadline: .now() + max(0, at - clock()), execute: item)
  }
}

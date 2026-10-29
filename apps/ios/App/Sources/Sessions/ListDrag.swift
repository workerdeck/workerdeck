import SwiftUI
import UIKit

enum ListDragSubject: Equatable {
  case group(String)
  case card(String)
}

// Global coordinates: a named space does not resolve from inside a List's cells and headers.
struct ListDragSession: Equatable {
  let subject: ListDragSubject
  let frame: CGRect
  let startY: CGFloat
  var y: CGFloat

  var lifted: CGRect { frame.offsetBy(dx: 0, dy: y - startY) }
}

// Written on every scroll, so a plain box rather than state: a frame moving must not redraw the list.
final class ListFrames {
  var cards: [String: CGRect] = [:]
  var groups: [String: CGRect] = [:]
  var list: CGRect = .zero
}

// On the List's own collection view and not a long press: `.contextMenu` blocks both a row gesture and a long press.
@MainActor
final class ListLifter: NSObject, UIGestureRecognizerDelegate {
  struct Handlers {
    var canLift: (CGPoint) -> Bool = { _ in false }
    var lift: (CGPoint) -> Void = { _ in }
    var move: (CGPoint) -> Void = { _ in }
    var end: (Bool) -> Void = { _ in }
  }

  var handlers = Handlers()
  private weak var host: UIScrollView?

  func attach(near view: UIView) {
    var ancestor = view.superview
    while let candidate = ancestor, !(candidate is UICollectionView) { ancestor = candidate.superview }
    guard let list = ancestor as? UICollectionView, list !== host else { return }
    host = list
    let recognizer = HoldThenMove(target: self, action: #selector(handle(_:)))
    recognizer.delegate = self
    list.addGestureRecognizer(recognizer)
  }

  @objc private func handle(_ recognizer: HoldThenMove) {
    let point = recognizer.location(in: nil)
    switch recognizer.state {
    case .began:
      recognizer.cancelOthers()
      handlers.lift(recognizer.origin)
      handlers.move(point)
    case .changed: handlers.move(point)
    case .ended: handlers.end(true)
    case .cancelled, .failed: handlers.end(false)
    default: break
    }
  }

  func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    handlers.canLift(touch.location(in: nil))
  }

  func gestureRecognizer(
    _ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    !(other is UIPanGestureRecognizer)
  }
}

// Moving before the hold is up fails it, so a scroll or a swipe never waits on it.
final class HoldThenMove: UIGestureRecognizer {
  private let hold: TimeInterval = 0.15
  private let slop: CGFloat = 6
  private(set) var origin: CGPoint = .zero
  private var armed = false
  private var timer: Timer?
  private weak var touched: UIView?

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    guard touches.count == 1, let touch = touches.first, event.allTouches?.count == 1 else {
      state = .failed
      return
    }
    origin = touch.location(in: nil)
    touched = touch.view
    timer = Timer.scheduledTimer(withTimeInterval: hold, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.armed = true }
    }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let point = touches.first?.location(in: nil) else { return }
    switch state {
    case .possible:
      let moved = hypot(point.x - origin.x, point.y - origin.y)
      if !armed {
        if moved > 10 { state = .failed }
      } else if abs(point.y - origin.y) > slop {
        state = .began
      }
    case .began, .changed:
      state = .changed
    default:
      break
    }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    state = state == .began || state == .changed ? .ended : .failed
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    state = state == .began || state == .changed ? .cancelled : .failed
  }

  // Toggling `isEnabled` is how UIKit cancels a recognizer that has already begun.
  func cancelOthers() {
    var view = touched
    while let current = view {
      for other in current.gestureRecognizers ?? [] where other !== self && other.isEnabled {
        other.isEnabled = false
        other.isEnabled = true
      }
      view = current === self.view ? nil : current.superview
    }
  }

  override func reset() {
    timer?.invalidate()
    timer = nil
    armed = false
  }
}

struct ListLiftHook: UIViewRepresentable {
  let lifter: ListLifter
  let handlers: ListLifter.Handlers

  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    view.isUserInteractionEnabled = false
    return view
  }

  func updateUIView(_ view: UIView, context: Context) {
    lifter.handlers = handlers
    DispatchQueue.main.async { lifter.attach(near: view) }
  }
}

extension View {
  func listFrame(_ write: @escaping (CGRect) -> Void) -> some View {
    onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { write($0) }
  }
}

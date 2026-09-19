import Foundation

// A scroll view's vertical range in content-offset space: `top` shows the first point of
// content under the top inset, `bottom` the last point above the bottom inset - or `top`
// again when the content is shorter than the frame.
public struct TranscriptScrollGeometry: Equatable, Sendable {
  public var contentHeight: CGFloat
  public var frameHeight: CGFloat
  public var insetTop: CGFloat
  public var insetBottom: CGFloat

  public init(
    contentHeight: CGFloat, frameHeight: CGFloat, insetTop: CGFloat, insetBottom: CGFloat
  ) {
    self.contentHeight = contentHeight
    self.frameHeight = frameHeight
    self.insetTop = insetTop
    self.insetBottom = insetBottom
  }

  public var top: CGFloat { -insetTop }

  public var bottom: CGFloat { max(top, contentHeight + insetBottom - frameHeight) }

  public func clamped(_ offset: CGFloat) -> CGFloat { min(max(offset, top), bottom) }

  // A jump decides the pin from where it lands, not from where it left: landing within
  // `threshold` of the bottom *is* going to the bottom. Never while the transcript is still
  // filling - that bottom is only the bottom of what has arrived so far, and a pin taken there
  // is dragged down by everything that lands after it.
  public func pinsAfterJump(to offset: CGFloat, threshold: CGFloat, complete: Bool) -> Bool {
    complete && offset >= bottom - threshold
  }
}

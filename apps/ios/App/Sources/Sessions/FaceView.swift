import SwiftUI
import WorkerDeckCore

// Draws the core's face drawing and runs its motions; the shapes, colours and keyframes all come from the core.
struct FaceView: View {
  let spec: FaceSpec
  let size: CGFloat
  var context = false

  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var start = Date()

  // The overlays (bubble, ring, chip) reach past the 32-unit box; the canvas keeps this margin around it.
  private static let margin: CGFloat = 4

  var body: some View {
    let drawing = faceDrawing(spec: spec, size: Double(size), dark: scheme == .dark, showContext: context)
    let moving = !reduceMotion && drawing.ops.contains { if case .push(let g) = $0 { !g.motions.isEmpty } else { false } }
    let outer = size * (32 + 2 * Self.margin) / 32
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !moving)) { timeline in
      let t = moving ? timeline.date.timeIntervalSince(start) : -1
      Canvas { ctx, _ in
        ctx.scaleBy(x: size / 32, y: size / 32)
        ctx.translateBy(x: Self.margin, y: Self.margin)
        FaceCanvas.draw(drawing.ops, in: ctx, at: t)
      }
      .frame(width: outer, height: outer)
    }
    .frame(width: size, height: size)
    .opacity(drawing.opacity)
    .onChange(of: spec.state) { start = Date() }
    .accessibilityHidden(true)
  }
}

enum FaceCanvas {
  private static let tables: [FaceMotionKind: [Float]] = Dictionary(
    faceMotionTables().map { ($0.kind, $0.samples) }, uniquingKeysWith: { a, _ in a })

  static func draw(_ ops: [FaceOp], in root: GraphicsContext, at t: Double) {
    var stack = [root]
    for op in ops {
      switch op {
      case .push(let group):
        var ctx = stack[stack.count - 1]
        let m = group.transform
        ctx.concatenate(CGAffineTransform(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5]))
        if !group.clip.isEmpty {
          var clip = Path()
          for c in group.clip { clip.addPath(rounded(c.x, c.y, c.width, c.height, c.radius)) }
          ctx.clip(to: clip)
        }
        if t >= 0 {
          for motion in group.motions {
            let (transform, opacity) = sample(motion, at: t)
            ctx.concatenate(transform)
            ctx.opacity *= opacity
          }
        }
        stack.append(ctx)
      case .pop:
        stack.removeLast()
      case .rect(let r):
        paint(rounded(r.x, r.y, r.width, r.height, r.radius), fill: r.fill, stroke: r.stroke, opacity: r.opacity, in: stack[stack.count - 1])
      case .path(let p):
        paint(path(p.segs), fill: p.fill, stroke: p.stroke, opacity: p.opacity, in: stack[stack.count - 1])
      }
    }
  }

  // A motion at `t` seconds into its state: the transform pivots on the motion's origin, like CSS `transform-box: fill-box`.
  static func sample(_ m: FaceMotion, at t: Double) -> (CGAffineTransform, Double) {
    let local = t - m.delay
    guard let samples = tables[m.kind], samples.count >= 12, m.duration > 0, local >= 0,
      m.iterations == 0 || local < m.duration * Double(m.iterations)
    else { return (.identity, 1) }
    var p = local.truncatingRemainder(dividingBy: m.duration) / m.duration
    if m.reverse { p = 1 - p }
    let n = samples.count / 6
    let f = p * Double(n - 1)
    let i = min(Int(f), n - 2)
    let k = Float(f - Double(i))
    let v = (0..<6).map { CGFloat(samples[i * 6 + $0] + (samples[(i + 1) * 6 + $0] - samples[i * 6 + $0]) * k) }
    let transform = CGAffineTransform(translationX: m.originX + v[0], y: m.originY + v[1])
      .rotated(by: v[4] * .pi / 180)
      .scaledBy(x: v[2], y: v[3])
      .translatedBy(x: -m.originX, y: -m.originY)
    return (transform, Double(v[5]))
  }

  private static func rounded(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ r: Double) -> Path {
    let radius = min(r, w / 2, h / 2)
    let rect = CGRect(x: x, y: y, width: w, height: h)
    return radius > 0 ? Path(roundedRect: rect, cornerRadius: radius, style: .circular) : Path(rect)
  }

  private static func path(_ segs: [FaceSeg]) -> Path {
    var path = Path()
    for seg in segs {
      switch seg {
      case .move(let x, let y): path.move(to: CGPoint(x: x, y: y))
      case .line(let x, let y): path.addLine(to: CGPoint(x: x, y: y))
      case .quad(let cx, let cy, let x, let y): path.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: cx, y: cy))
      case .close: path.closeSubpath()
      }
    }
    return path
  }

  private static func paint(_ shape: Path, fill: UInt32?, stroke: FaceStroke?, opacity: Double, in parent: GraphicsContext) {
    var ctx = parent
    ctx.opacity *= opacity
    if let fill { ctx.fill(shape, with: .color(color(fill))) }
    if let stroke {
      let style = StrokeStyle(
        lineWidth: stroke.width, lineCap: stroke.roundCap ? .round : .butt, lineJoin: stroke.roundJoin ? .round : .miter)
      ctx.stroke(shape, with: .color(color(stroke.color)), style: style)
    }
  }

  private static func color(_ argb: UInt32) -> Color {
    Color(
      .displayP3, red: Double((argb >> 16) & 0xff) / 255, green: Double((argb >> 8) & 0xff) / 255,
      blue: Double(argb & 0xff) / 255)
  }
}

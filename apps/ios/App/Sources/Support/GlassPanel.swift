import SwiftUI

/// The app's one "glass" decoration: a translucent, hairline-edged panel that
/// lets the transcript show through it.
///
/// iOS 26 has the real thing — `glassEffect` refracts what scrolls underneath and
/// reacts to motion. 17–25 get the closest honest approximation, a blurred
/// material with a hairline border. Both live here so call sites ask for a glass
/// panel rather than branching on which OS they are running.
extension View {
  func glassPanel(cornerRadius: CGFloat) -> some View {
    modifier(GlassPanel(cornerRadius: cornerRadius))
  }

  /// A glass panel that *is* the coloured card — for a prompt that needs both a
  /// readable surface over the scrolling transcript and an unmistakable colour.
  ///
  /// The alternative, a tinted card nested inside a plain glass panel, draws two
  /// concentric rounded rectangles for one thing and reads as a card that failed
  /// to fill its container. Here the tint and the hairline are the panel, so
  /// there is exactly one card. On iOS 26 the tint goes through `glassEffect`,
  /// which refracts it properly; below, it layers over the material.
  func glassPanel(cornerRadius: CGFloat, tint: Color) -> some View {
    modifier(GlassPanel(cornerRadius: cornerRadius, tint: tint))
  }

  /// The pill behind a control that sits *inside* a glass panel — a chip, a round
  /// button. Deliberately a flat tint rather than more glass: blur over blur has
  /// nothing left to refract, and on iOS 26 it renders as very nearly nothing.
  func glassPill(cornerRadius: CGFloat = 999) -> some View {
    background(
      Color.primary.opacity(0.10),
      in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
  }
}

private struct GlassPanel: ViewModifier {
  let cornerRadius: CGFloat
  /// Nil = the neutral panel; set = the panel is the coloured card itself.
  var tint: Color?

  @ViewBuilder
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    // The border carries the colour harder than the fill does — a 12% tint over
    // glass is nearly invisible on a dark transcript, which is why the nested
    // version needed a stroke to read as "attention" at all.
    let border = tint?.opacity(0.45) ?? Color.primary.opacity(0.12)
    if #available(iOS 26.0, *) {
      content
        .glassEffect(tint.map { .regular.tint($0.opacity(0.18)) } ?? .regular, in: shape)
        .overlay(shape.strokeBorder(border))
    } else {
      content
        .background(.regularMaterial, in: shape)
        // Over the material, not under it: a tint beneath a blur is a tint you
        // cannot see.
        .overlay(shape.fill(tint?.opacity(0.14) ?? .clear))
        .overlay(shape.strokeBorder(border))
    }
  }
}

/// Resign whatever is first responder — the "tapped outside the composer" and
/// "tapped the hide-keyboard button" gesture, in the one form that works for the
/// UIKit-backed editor as well as any SwiftUI field.
@MainActor
func dismissKeyboard() {
  UIApplication.shared.sendAction(
    #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

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

  @ViewBuilder
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    if #available(iOS 26.0, *) {
      content.glassEffect(.regular, in: shape)
    } else {
      content
        .background(.regularMaterial, in: shape)
        .overlay(shape.strokeBorder(Color.primary.opacity(0.12)))
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

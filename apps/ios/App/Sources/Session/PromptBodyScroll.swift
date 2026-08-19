import SwiftUI

/// Bounds a prompt's body and lets it scroll, so its actions are always on
/// screen.
///
/// This is the fix for a bug both prompt themes had, and it is worth stating
/// where it came from rather than reading as a layout preference. The prompts
/// live in the footer, which is a `safeAreaInset(edge: .bottom)`, and a
/// safe-area inset is sized to its content with no scrolling of its own. A
/// prompt taller than the screen therefore neither scrolled nor shrank: it
/// pushed its own Allow/Deny row off the bottom edge, where nothing could reach
/// it. A long question was *unanswerable* — not awkward, unanswerable.
///
/// The `lineLimit`s that used to sit on descriptions and previews were an
/// attempt at the same problem and made it worse in the one way that matters:
/// they hid the text you needed in order to choose, while still not bounding the
/// total height, so six options ran off the screen *and* were each truncated.
/// They are gone. The scroll is the height bound now, so nothing else has to be.
///
/// A `ScrollView` is greedy along its scroll axis — proposed nothing, it takes
/// everything — so it cannot simply be handed a `maxHeight` and asked to
/// shrink-wrap a short prompt. Measuring the content and pinning the scroller to
/// `min(measured, cap)` is what makes a two-line prompt two lines tall and a
/// forty-line prompt exactly the cap.
struct PromptBodyScroll<Content: View>: View {
  let maxHeight: CGFloat
  @ViewBuilder var content: Content

  @State private var height: CGFloat = 0

  var body: some View {
    ScrollView {
      content
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          GeometryReader { proxy in
            Color.clear.preference(key: PromptBodyHeight.self, value: proxy.size.height)
          })
    }
    .frame(height: min(max(height, 1), maxHeight))
    // No bounce while it all fits: a body that rubber-bands with nothing to
    // scroll to reads as a list with more below it.
    .scrollBounceBehavior(.basedOnSize)
    .onPreferenceChange(PromptBodyHeight.self) { height = $0 }
  }
}

struct PromptBodyHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

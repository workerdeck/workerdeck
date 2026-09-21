import WorkerDeckKit
import SwiftUI

/// One session card: the two-line row and, when there is something to disclose,
/// the step count that opens it.
///
/// Internal, and a view rather than a method on the list, so `UIPREVIEW=sessions`
/// can draw the composition the list actually ships - the disclosure's placement
/// is the thing that needed looking at, and a preview of the row alone cannot
/// show it.
struct SessionCardView<MenuContent: View>: View {
  let row: SessionRow
  let onOpen: () -> Void
  var hostName: String?
  var projectImage: UIImage?
  var showsProject: Bool = true
  // Required, and required deliberately: a card that can be built without a menu
  // is a card a preview can draw *simpler* than the app ships it, which is how
  // the missing chevron got past a green screenshot. Callers with nothing to
  // offer pass `EmptyView()` and say so.
  @ViewBuilder var menu: () -> MenuContent

  var body: some View {
    Button(action: onOpen) {
      SessionRowView(
        session: row.info, hostName: hostName, unseen: row.unseen,
        projectImage: projectImage, showsProject: showsProject)
        // A list-row button paints its label in the accent colour; the title must stay primary.
        .foregroundStyle(.primary)
    }
    .overlay(alignment: .bottomTrailing) { overflow }
  }

  // Persistent, not revealed: the dashboard hides the same actions behind hover
  // and a phone has no hover, so the frame's always-there spelling is the mobile
  // treatment rather than a difference to reconcile away. It duplicates the
  // swipes on purpose - a swipe is only found by someone who already guessed.
  private var overflow: some View {
    Menu {
      menu()
    } label: {
      SessionOverflowGlyph()
        .padding(.bottom, SessionRowView.verticalPadding)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .contentShape(Rectangle())
    }
    // A `Menu` paints its label in the accent colour, and on this row the accent
    // is a *state* - a running step count wears it. An always-present control
    // wearing the same blue reads as something happening on every row.
    .tint(Color.secondary)
    .accessibilityLabel("Session actions")
  }
}

// The overflow affordance, drawn identically whether it is the live control
// (`SessionCardView`) or the hidden placeholder that reserves its width in the
// row. One view for both, because the two drifting apart is the whole failure
// mode: the run would truncate against a slot of the wrong size.
struct SessionOverflowGlyph: View {
  var body: some View {
    Image(systemName: "ellipsis")
      .font(.caption.weight(.semibold))
      .foregroundStyle(.secondary)
      .padding(.leading, 12)
      .padding(.trailing, 2)
  }
}

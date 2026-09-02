import WorkerDeckKit
import SwiftUI

/// One session card: the two-line row and, when there is something to disclose,
/// the step count that opens it.
///
/// Internal, and a view rather than a method on the list, so `UIPREVIEW=sessions`
/// can draw the composition the list actually ships — the disclosure's placement
/// is the thing that needed looking at, and a preview of the row alone cannot
/// show it.
struct SessionCardView<MenuContent: View>: View {
  let row: SessionRow
  let onOpen: () -> Void
  var hostName: String?
  var projectImage: UIImage?
  var showsProject: Bool = true
  var expanded: Bool = false
  var onToggle: () -> Void = {}
  // Required, and required deliberately: a card that can be built without a menu
  // is a card a preview can draw *simpler* than the app ships it, which is how
  // the missing chevron got past a green screenshot. Callers with nothing to
  // offer pass `EmptyView()` and say so.
  @ViewBuilder var menu: () -> MenuContent

  var body: some View {
    Button(action: onOpen) {
      SessionRowView(
        session: row.info, hostName: hostName, unseen: row.unseen,
        projectImage: projectImage, showsProject: showsProject, expanded: expanded)
        // A list-row button paints its label in the accent colour; the title must stay primary.
        .foregroundStyle(.primary)
    }
    .overlay(alignment: .bottomTrailing) {
      HStack(spacing: 0) {
        toggle
        overflow
      }
    }
  }

  // Persistent, not revealed: the dashboard hides the same actions behind hover
  // and a phone has no hover, so the frame's always-there spelling is the mobile
  // treatment rather than a difference to reconcile away. It duplicates the
  // swipes on purpose — a swipe is only found by someone who already guessed.
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
    // is a *state* — a running step count wears it. An always-present control
    // wearing the same blue reads as something happening on every row.
    .tint(Color.secondary)
    .accessibilityLabel("Session actions")
  }

  @ViewBuilder
  private var toggle: some View {
    let steps = sessionSteps(row.info)
    if !steps.isEmpty {
      let running = runningSteps(steps)
      Button(action: onToggle) {
        StepDisclosure(expanded: expanded, running: running, total: steps.count)
          .padding(.bottom, SessionRowView.verticalPadding)
          .frame(maxHeight: .infinity, alignment: .bottom)
          .contentShape(Rectangle())
      }
      // `.plain` because a bordered button inside a list row draws a second
      // surface, and because the default style would tint the chevron with the
      // accent colour on a row where the accent has a meaning of its own.
      .buttonStyle(.plain)
      .accessibilityLabel(
        (expanded ? "Hide " : "Show ")
          + stepCountWords(running: running, total: steps.count))
    }
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

struct StepDisclosure: View {
  let expanded: Bool
  let running: Int
  let total: Int

  var body: some View {
    HStack(spacing: 2) {
      Image(systemName: expanded ? "chevron.down" : "chevron.right")
        .font(.caption2.weight(.semibold))
      Text(stepCountLabel(running: running, total: total))
        .font(.caption)
        .monospacedDigit()
    }
    .foregroundStyle(running > 0 ? Color.accentColor : .secondary)
    .padding(.leading, 10)
  }
}

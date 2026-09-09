import WorkerDeckKit
import SwiftUI

/// The scrolling transcript, bottom-anchored.
///
/// Auto-scroll follows the tail *unless* the user has scrolled up, so reading
/// back through a long run isn't yanked away every time a delta lands. "Near the
/// bottom" is tracked with a sentinel row at the end of the `LazyVStack`: it is
/// only realized when the tail is inside the lazy render window, which is exactly
/// the condition we want and costs nothing to observe.
struct TranscriptListView: View {
  let items: [TranscriptItem]
  /// Change signal that also fires for streaming text (which doesn't grow `items`).
  let revision: Int
  /// The catch-up seam: the item index the reader had read to, and the recap
  /// line describing what has arrived since. Drawn as a divider before that
  /// item, with everything above it faded — the terminal renderer splices a row
  /// into its fold instead, and the two are deliberately separate: nothing
  /// under this renderer asks which variant it is in.
  var catchUp: (at: Int, label: String)? = nil
  /// Bumped by the "jump" button on the catch-up bar. A nonce rather than a
  /// boolean, so a second press after scrolling away travels.
  var jumpToRecap: Int = 0

  @Environment(\.transcriptVariant) private var variant
  @Environment(\.transcriptDensity) private var density

  @State private var expanded: Set<String> = []
  @State private var isNearBottom = true

  private static let bottomAnchor = "transcript-bottom"
  private static let recapAnchor = "transcript-recap"

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        // The one vertical separation between rows there is, which is what makes
        // it the whole of the density feature.
        LazyVStack(alignment: .leading, spacing: transcriptRowGap(variant, density)) {
          ForEach(Array(items.enumerated()), id: \.element.rowID) { index, item in
            if let catchUp, catchUp.at == index {
              RecapDivider(label: catchUp.label).id(Self.recapAnchor)
            }
            TranscriptItemView(item: item, isExpanded: expansion(item.rowID))
              .id(item.rowID)
              // Already read, at the web client's own 45%.
              .opacity(catchUp.map { index < $0.at ? 0.45 : 1 } ?? 1)
          }
          Color.clear
            .frame(height: 1)
            .id(Self.bottomAnchor)
            .onAppear { isNearBottom = true }
            .onDisappear { isNearBottom = false }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .overlay(alignment: .bottomTrailing) {
        if !isNearBottom {
          JumpToBottomButton {
            withAnimation { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
          }
          .padding(.trailing, 14)
          .padding(.bottom, 10)
        }
      }
      // Two triggers on purpose: a new row is worth animating, a streamed
      // character is not (animating every delta looks like a stutter).
      .onChange(of: items.count) { _, _ in
        guard isNearBottom else { return }
        withAnimation(.easeOut(duration: 0.18)) {
          proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
        }
      }
      .onChange(of: revision) { _, _ in
        guard isNearBottom else { return }
        proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
      }
      .onChange(of: jumpToRecap) { _, _ in
        guard jumpToRecap > 0 else { return }
        withAnimation { proxy.scrollTo(Self.recapAnchor, anchor: .top) }
      }
      .onAppear {
        proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
      }
    }
  }

  private func expansion(_ key: String) -> Binding<Bool> {
    Binding(
      get: { expanded.contains(key) },
      set: { open in
        if open {
          expanded.insert(key)
        } else {
          expanded.remove(key)
        }
      })
  }
}

/// The seam itself: a rule, and under it what happened while the reader was
/// away. The terminal theme draws the same sentence as a row of its own
/// (`TerminalPlanner`'s `.recap`).
///
/// The label sits **under** the rule rather than inside it, unlike the web's
/// centred `— ※ recap: … —`: the recap is a sentence with counts and tool names
/// in it, the phone is 390pt wide, and a label boxed between two rules had to
/// be clipped to "1 turn…" — which is the one thing this row exists to say.
private struct RecapDivider: View {
  let label: String

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Rectangle().fill(Color.secondary.opacity(0.25)).frame(height: 1)
      Text("\(TermGlyph.recap) recap: \(label)")
        .font(.caption2.monospaced())
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 2)
  }
}

private struct JumpToBottomButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: "arrow.down")
        .font(.footnote.weight(.semibold))
        .padding(9)
        .background(.regularMaterial, in: Circle())
        .overlay(Circle().strokeBorder(Color.secondary.opacity(0.2)))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Jump to latest")
  }
}

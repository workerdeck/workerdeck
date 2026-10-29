import SwiftUI
import WorkerDeckCore

// `SessionItem`'s gutter row, for a list with no agent in it: status over the engine mark, the name, unread and the
// context ring; then model · status · project · gateway · profile · cost as one truncating run, and the step chips.
struct SessionRowView: View {
  let row: ListRow
  var hostName: String?
  var unseen: Int = 0
  // Must already be glyph-boxed (`ProjectIconLoader` does it): a `Text` image has no frame to constrain it with.
  var projectImage: UIImage?
  // False under a project group: the heading names the project, so the slot carries the sub-path inside it.
  var showsProject: Bool = true
  var chips: StepChipsView?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        SessionStatusIcon(row: row).frame(width: 16)
        Text(row.title)
          .font(ListType.body(.medium))
          .tracking(ListType.tracking * 13)
          .foregroundStyle(ListPalette.fg1)
          .lineLimit(1)
        Spacer(minLength: 0)
        UnreadBadge(count: unseen, live: row.state == .working)
        if let percentage = row.contextPercent {
          ContextRing(percentage: percentage, diameter: 14, lineWidth: 2, showsLabel: false)
        }
      }
      .frame(minHeight: 20)
      HStack(spacing: 6) {
        EngineIconView(mark: row.mark, tinted: row.markTinted, size: 16).frame(width: 16)
        Self.details(row: row, hostName: hostName, showsProject: showsProject, projectImage: projectImage)
          .font(ListType.body())
          .tracking(ListType.tracking * 13)
          .foregroundStyle(ListPalette.fg4)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
        chips
      }
      .frame(minHeight: 20)
    }
    .padding(.leading, 2)
    .padding(.vertical, 2)
    .opacity(row.asleep ? 0.6 : 1)
  }

  static func details(row: ListRow, hostName: String?, showsProject: Bool, projectImage: UIImage?) -> Text {
    var parts: [Text] = []
    if let model = row.modelLabel {
      parts.append(Text(model).foregroundStyle(row.modelTint))
    }
    if let status = row.status {
      parts.append(Text(status).foregroundStyle(ListPalette.fg3))
    }
    if let project = showsProject ? row.project : row.projectSubpath {
      let icon = showsProject ? projectIconText(row: row, image: projectImage) : nil
      parts.append((icon ?? Text("")) + Text(project))
    }
    for extra in [hostName, row.profile.map { "@\($0)" }, row.costText].compactMap({ $0 }) {
      parts.append(Text(extra))
    }
    return parts.enumerated().reduce(Text("")) { joined, part in
      part.offset == 0 ? part.element : joined + Text(" · ") + part.element
    }
  }

  // The project's glyph as a character in the run, so it truncates with the name it labels; nil draws nothing.
  private static func projectIconText(row: ListRow, image: UIImage?) -> Text? {
    if let name = row.projectGlyph {
      return Text(Image(systemName: projectSymbol(forLucideName: name))) + Text("\u{2005}")
    }
    guard row.projectIconHash != nil, let image else { return nil }
    return Text(Image(uiImage: image)) + Text("\u{2005}")
  }
}

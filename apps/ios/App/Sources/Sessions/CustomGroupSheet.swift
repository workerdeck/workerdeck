import PhotosUI
import SwiftUI
import WorkerDeckCore

// A custom group's badge: its image, else its colour square. `GroupBadge` on the dashboard.
struct CustomGroupBadge: View {
  let color: String?
  let icon: String?

  var body: some View {
    Group {
      if let image = icon.flatMap(CustomGroupIcon.image) {
        Image(uiImage: image).resizable().scaledToFill().frame(width: 14, height: 14)
          .clipShape(RoundedRectangle(cornerRadius: 3))
      } else {
        RoundedRectangle(cornerRadius: 2)
          .fill(color.flatMap { Color(cliToken: $0) } ?? ListPalette.fg4)
          .frame(width: 8, height: 8)
      }
    }
    .frame(width: 14, height: 14)
    .accessibilityHidden(true)
  }
}

// The group a sheet edits, by id.
struct GroupEdit: Identifiable {
  let id: String
}

// Name, colour or image, and delete for one custom group; every change applies as it is made.
struct CustomGroupSheet: View {
  let id: String
  let model: SessionListModel
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var photo: PhotosPickerItem?
  @State private var imageError: String?
  @State private var confirmDelete = false

  private var choice: GroupChoice? { model.customGroups.first { $0.id == id } }

  var body: some View {
    NavigationStack {
      Form {
        Section("Name") {
          TextField("Group name", text: $name)
            .submitLabel(.done)
            .onSubmit(commitName)
            .accessibilityIdentifier("GroupName")
        }
        Section("Colour") {
          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4), spacing: 10) {
            ForEach(model.groupColors, id: \.self) { color in
              let chosen = choice?.icon == nil && choice?.color == color
              Button {
                model.setCustomGroupColor(id, color)
              } label: {
                RoundedRectangle(cornerRadius: 6)
                  .fill(Color(cliToken: color) ?? .gray)
                  .frame(height: 32)
                  .overlay {
                    if chosen {
                      Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    }
                  }
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Colour \(color)")
              .accessibilityAddTraits(chosen ? .isSelected : [])
            }
          }
          .padding(.vertical, 4)
        }
        Section {
          PhotosPicker(selection: $photo, matching: .images) {
            Label("Choose image…", systemImage: "photo")
          }
          if choice?.icon != nil {
            Button("Remove image") { model.setCustomGroupIcon(id, nil) }
          }
          if let imageError {
            Text(imageError).foregroundStyle(.red).font(.footnote)
          }
        } header: {
          Text("Image")
        } footer: {
          Text("An image replaces the colour in the group's heading.")
        }
        Section {
          Button("Delete group", role: .destructive) { confirmDelete = true }
        } footer: {
          Text("Its sessions move to Ungrouped.")
        }
      }
      .navigationTitle(choice?.name ?? "Group")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            commitName()
            dismiss()
          }
        }
      }
      .confirmationDialog("Delete \(choice?.name ?? "this group")?", isPresented: $confirmDelete, titleVisibility: .visible) {
        Button("Delete group", role: .destructive) {
          model.removeCustomGroup(id)
          dismiss()
        }
      } message: {
        Text("Its sessions move to Ungrouped.")
      }
    }
    .onAppear { name = choice?.name ?? "" }
    .onDisappear(perform: commitName)
    .onChange(of: photo) { _, item in
      guard let item else { return }
      photo = nil
      imageError = nil
      Task {
        guard let data = try? await item.loadTransferable(type: Data.self), let icon = CustomGroupIcon.dataURL(from: data) else {
          imageError = "That image could not be read."
          return
        }
        model.setCustomGroupIcon(id, icon)
      }
    }
    .presentationDetents([.medium, .large])
  }

  private func commitName() {
    guard choice != nil, name.trimmingCharacters(in: .whitespaces) != choice?.name else { return }
    model.renameCustomGroup(id, to: name)
  }
}

// The dashboard's `iconFromFile`: scaled to cover a 64 px square and stored as a PNG data URL in the view config.
@MainActor
enum CustomGroupIcon {
  private static let side: CGFloat = 64
  private static let cache = NSCache<NSString, UIImage>()

  static func dataURL(from data: Data) -> String? {
    guard let source = UIImage(data: data), source.size.width > 0, source.size.height > 0 else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let scale = max(side / source.size.width, side / source.size.height)
    let size = CGSize(width: source.size.width * scale, height: source.size.height * scale)
    let png = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).pngData { _ in
      source.draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2, width: size.width, height: size.height))
    }
    return "data:image/png;base64,\(png.base64EncodedString())"
  }

  static func image(_ url: String) -> UIImage? {
    if let hit = cache.object(forKey: url as NSString) { return hit }
    guard url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ","),
      let data = Data(base64Encoded: String(url[url.index(after: comma)...])), let image = UIImage(data: data)
    else { return nil }
    cache.setObject(image, forKey: url as NSString)
    return image
  }
}

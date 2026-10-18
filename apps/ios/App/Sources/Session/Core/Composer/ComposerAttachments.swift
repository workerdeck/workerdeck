import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

struct PickedFile {
  let name: String
  let mediaType: String
  let data: Data
  let thumbnail: UIImage?
}

// The core decides which bytes go out as picked and which are scaled and re-encoded; this only does the pixels.
enum AttachmentNormalizer {
  static let pasteboardImageTypes: [(UTType, String)] = [
    (.png, "image/png"), (.jpeg, "image/jpeg"), (.gif, "image/gif"), (.webP, "image/webp"),
  ]

  // A picture with no bytes of its own (camera, a decoded clipboard image) always goes out as JPEG.
  static func image(_ image: UIImage, name: String) -> PickedFile? {
    jpeg(image, plan: imagePlan(name: name, mediaType: nil, width: pixels(image.size.width), height: pixels(image.size.height)))
  }

  static func file(data: Data, name: String, mediaType: String) -> PickedFile? {
    guard mediaType.hasPrefix("image/"), let image = UIImage(data: data) else {
      return PickedFile(name: name, mediaType: mediaType, data: data, thumbnail: nil)
    }
    let plan = imagePlan(
      name: name, mediaType: mediaType, width: pixels(image.size.width), height: pixels(image.size.height))
    if case .keep = plan {
      return PickedFile(name: name, mediaType: mediaType, data: data, thumbnail: thumbnail(image))
    }
    return jpeg(image, plan: plan)
  }

  private static func pixels(_ value: CGFloat) -> UInt32 { UInt32(clamping: Int(value.rounded())) }

  private static func jpeg(_ image: UIImage, plan: ImagePlan) -> PickedFile? {
    guard case .jpeg(let name, let width, let height) = plan else { return nil }
    let scaled = render(image, width: width, height: height, scale: 1)
    guard let data = scaled.jpegData(compressionQuality: CGFloat(imageJpegQuality())) else { return nil }
    return PickedFile(name: name, mediaType: "image/jpeg", data: data, thumbnail: thumbnail(scaled))
  }

  private static func render(_ image: UIImage, width: UInt32, height: UInt32, scale: CGFloat?) -> UIImage {
    let size = CGSize(width: CGFloat(width), height: CGFloat(height))
    let format = UIGraphicsImageRendererFormat.default()
    if let scale { format.scale = scale }
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  private static func thumbnail(_ image: UIImage) -> UIImage {
    let size = attachmentThumbnailSize(width: pixels(image.size.width), height: pixels(image.size.height))
    return render(image, width: max(size[0], 1), height: max(size[1], 1), scale: nil)
  }

  static func mediaType(for url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
  }

  static func importableTypes(_ kinds: Set<String>) -> [UTType] {
    if kinds.isSuperset(of: ["image", "pdf", "text"]) { return [.item] }
    var types: [UTType] = []
    if kinds.contains("image") { types.append(.image) }
    if kinds.contains("pdf") { types.append(.pdf) }
    if kinds.contains("text") { types.append(.text) }
    return types.isEmpty ? [.item] : types
  }
}

// The staged files above the field: a local thumbnail with the upload's state on top, tap to retry, x to remove.
struct ComposerAttachmentStrip: View {
  let model: ComposerModel

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(model.chips, id: \.id) { chip in
          ComposerAttachmentChip(
            chip: chip, thumbnail: model.thumbnails[chip.id], onRetry: { model.retry(chip.id) },
            onRemove: { model.remove(chip.id) })
        }
      }
      .padding(.horizontal, 6)
      .padding(.top, 2)
    }
    .frame(height: 72)
  }
}

private struct ComposerAttachmentChip: View {
  let chip: AttachmentChip
  let thumbnail: UIImage?
  let onRetry: () -> Void
  let onRemove: () -> Void

  private var failed: Bool {
    if case .failed = chip.status { return true }
    return false
  }

  var body: some View {
    ZStack(alignment: .topTrailing) {
      content
        .frame(width: 54, height: 54)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(TerminalPalette.cellStroke))
        .overlay { status }
        .onTapGesture { if failed { onRetry() } }
        .accessibilityElement()
        .accessibilityLabel(chip.accessibilityLabel)
        .accessibilityIdentifier("Attachment")
      Button(action: onRemove) {
        Image(systemName: "xmark.circle.fill")
          .font(.system(size: 20))
          .symbolRenderingMode(.palette)
          .foregroundStyle(Color.white, Color.black.opacity(0.6))
          .frame(width: 40, height: 40)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .offset(x: 18, y: -18)
      .accessibilityLabel("Remove \(chip.name)")
    }
    .padding(.top, 10)
    .padding(.trailing, 10)
  }

  @ViewBuilder
  private var content: some View {
    if let thumbnail {
      Image(uiImage: thumbnail).resizable().scaledToFill()
    } else {
      VStack(spacing: 2) {
        Image(systemName: "doc").font(.footnote)
        Text(chip.extension).font(.system(size: 9, weight: .semibold)).lineLimit(1)
      }
      .foregroundStyle(TerminalPalette.color(.dim))
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(TerminalPalette.cellFill)
    }
  }

  @ViewBuilder
  private var status: some View {
    switch chip.status {
    case .uploading:
      ZStack {
        Color.black.opacity(0.35)
        ProgressView().controlSize(.small).tint(.white)
      }
    case .failed:
      ZStack {
        Color.black.opacity(0.45)
        Image(systemName: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
      }
    case .ready:
      EmptyView()
    }
  }
}

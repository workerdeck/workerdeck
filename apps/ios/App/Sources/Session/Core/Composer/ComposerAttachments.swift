import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WorkerDeckKit

// One staged file, from picked to sent. It exists before its upload lands, so the chip shows the moment it is picked.
@MainActor
@Observable
final class ComposerAttachment: Identifiable {
  enum State {
    case uploading
    case ready(remoteId: String)
    case failed(String)
  }

  let id = UUID()
  let name: String
  let mediaType: String
  let thumbnail: UIImage?
  let data: Data
  private(set) var state: State = .uploading

  init(_ picked: PickedFile) {
    name = picked.name
    mediaType = picked.mediaType
    thumbnail = picked.thumbnail
    data = picked.data
  }

  var remoteId: String? {
    if case .ready(let remoteId) = state { return remoteId }
    return nil
  }

  var failure: String? {
    if case .failed(let message) = state { return message }
    return nil
  }

  func settle(_ state: State) { self.state = state }
}

// Uploads start the moment a file is staged, so a send only names ids that already landed.
@MainActor
@Observable
final class ComposerAttachmentStore {
  private(set) var items: [ComposerAttachment] = []
  var errorText: String?
  var upload: (@Sendable (String, String, Data) async throws -> MessageAttachment)?

  var isEmpty: Bool { items.isEmpty }

  var isUploading: Bool {
    items.contains { if case .uploading = $0.state { true } else { false } }
  }

  // A failed upload blocks the send rather than silently dropping the picture from it.
  var hasFailure: Bool { items.contains { $0.failure != nil } }
  var readyIds: [String] { items.compactMap(\.remoteId) }

  func add(_ picked: PickedFile) {
    let item = ComposerAttachment(picked)
    items.append(item)
    send(item, announceFailure: true)
  }

  func retry(_ item: ComposerAttachment) {
    guard item.failure != nil else { return }
    item.settle(.uploading)
    send(item, announceFailure: false)
  }

  private func send(_ item: ComposerAttachment, announceFailure: Bool) {
    guard let upload else {
      item.settle(.failed("Not connected"))
      return
    }
    let (name, mediaType, data) = (item.name, item.mediaType, item.data)
    Task {
      do {
        let uploaded = try await upload(name, mediaType, data)
        item.settle(.ready(remoteId: uploaded.id))
      } catch {
        let message = (error as? WorkerClientError)?.message ?? error.localizedDescription
        item.settle(.failed(message))
        if announceFailure { errorText = message }
      }
    }
  }

  func remove(_ item: ComposerAttachment) { items.removeAll { $0.id == item.id } }
  func clear() { items.removeAll() }
}

struct PickedFile {
  let name: String
  let mediaType: String
  let data: Data
  let thumbnail: UIImage?
}

// iPhone photos are usually HEIC, which no model takes: images are transcoded and scaled to what a vision model uses.
enum AttachmentNormalizer {
  static let acceptedImageTypes: Set<String> = ["image/jpeg", "image/png", "image/gif", "image/webp"]
  static let maxImageEdge: CGFloat = 1568
  static let jpegQuality: CGFloat = 0.8

  static let pasteboardImageTypes: [(UTType, String)] = [
    (.png, "image/png"), (.jpeg, "image/jpeg"), (.gif, "image/gif"), (.webP, "image/webp"),
  ]

  static func image(_ image: UIImage, name: String, mediaType: String?) -> PickedFile? {
    let scaled = downscaled(image)
    if let mediaType, acceptedImageTypes.contains(mediaType), scaled === image,
      let data = mediaType == "image/png" ? image.pngData() : image.jpegData(compressionQuality: jpegQuality)
    {
      return PickedFile(name: name, mediaType: mediaType, data: data, thumbnail: thumbnail(scaled))
    }
    guard let data = scaled.jpegData(compressionQuality: jpegQuality) else { return nil }
    return PickedFile(name: renamed(name, to: "jpg"), mediaType: "image/jpeg", data: data, thumbnail: thumbnail(scaled))
  }

  // Exact bytes when the format and size already suit: a screenshot re-encoded to JPEG reads measurably worse.
  static func file(data: Data, name: String, mediaType: String) -> PickedFile? {
    if mediaType.hasPrefix("image/"), let image = UIImage(data: data) {
      if acceptedImageTypes.contains(mediaType), downscaled(image) === image {
        return PickedFile(name: name, mediaType: mediaType, data: data, thumbnail: thumbnail(image))
      }
      return self.image(image, name: name, mediaType: mediaType)
    }
    return PickedFile(name: name, mediaType: mediaType, data: data, thumbnail: nil)
  }

  static func mediaType(for url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
  }

  private static let textTypes: Set<String> = [
    "application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml",
    "application/javascript", "application/typescript", "application/x-sh", "application/x-httpd-php",
    "application/sql",
  ]

  // The capability kind a media type lands as; nil when unknown here, and then the gateway decides.
  static func kind(of mediaType: String) -> String? {
    let type =
      mediaType.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
      ?? mediaType.lowercased()
    if type.hasPrefix("image/") { return "image" }
    if type == "application/pdf" { return "pdf" }
    if type.hasPrefix("text/") || textTypes.contains(type) { return "text" }
    return nil
  }

  static func importableTypes(_ kinds: Set<String>) -> [UTType] {
    if kinds.isSuperset(of: ["image", "pdf", "text"]) { return [.item] }
    var types: [UTType] = []
    if kinds.contains("image") { types.append(.image) }
    if kinds.contains("pdf") { types.append(.pdf) }
    if kinds.contains("text") { types.append(.text) }
    return types.isEmpty ? [.item] : types
  }

  private static func downscaled(_ image: UIImage) -> UIImage {
    let longest = max(image.size.width, image.size.height)
    guard longest > maxImageEdge else { return image }
    let scale = maxImageEdge / longest
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  private static func thumbnail(_ image: UIImage) -> UIImage {
    let scale = 120 / max(image.size.width, image.size.height, 1)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    return UIGraphicsImageRenderer(size: size, format: .default()).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  private static func renamed(_ name: String, to ext: String) -> String {
    let stem = (name as NSString).deletingPathExtension
    return (stem.isEmpty ? "photo" : stem) + "." + ext
  }
}

// The staged files above the field: a local thumbnail with the upload's state on top, tap to retry, x to remove.
struct ComposerAttachmentStrip: View {
  let store: ComposerAttachmentStore

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(store.items) { item in
          ComposerAttachmentChip(item: item, onRetry: { store.retry(item) }, onRemove: { store.remove(item) })
        }
      }
      .padding(.horizontal, 6)
      .padding(.top, 2)
    }
    .frame(height: 62)
  }
}

private struct ComposerAttachmentChip: View {
  let item: ComposerAttachment
  let onRetry: () -> Void
  let onRemove: () -> Void

  var body: some View {
    ZStack(alignment: .topTrailing) {
      content
        .frame(width: 54, height: 54)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(TerminalPalette.cellStroke))
        .overlay { status }
        .onTapGesture { if item.failure != nil { onRetry() } }
        .accessibilityElement()
        .accessibilityLabel(item.failure.map { "\(item.name), failed: \($0). Tap to retry." } ?? item.name)
        .accessibilityIdentifier("Attachment")
      Button(action: onRemove) {
        Image(systemName: "xmark.circle.fill")
          .font(.footnote)
          .symbolRenderingMode(.palette)
          .foregroundStyle(Color.white, Color.black.opacity(0.55))
      }
      .buttonStyle(.plain)
      .offset(x: 5, y: -5)
      .accessibilityLabel("Remove \(item.name)")
    }
    .padding(.top, 5)
    .padding(.trailing, 5)
  }

  @ViewBuilder
  private var content: some View {
    if let thumbnail = item.thumbnail {
      Image(uiImage: thumbnail).resizable().scaledToFill()
    } else {
      VStack(spacing: 2) {
        Image(systemName: "doc").font(.footnote)
        Text(fileExtension).font(.system(size: 9, weight: .semibold)).lineLimit(1)
      }
      .foregroundStyle(TerminalPalette.color(.dim))
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(TerminalPalette.cellFill)
    }
  }

  @ViewBuilder
  private var status: some View {
    switch item.state {
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

  private var fileExtension: String {
    let ext = (item.name as NSString).pathExtension.uppercased()
    return ext.isEmpty ? "FILE" : ext
  }
}

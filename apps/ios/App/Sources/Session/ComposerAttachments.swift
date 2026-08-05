import WorkerDeckKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// One file staged on the composer, from picked to sent.
///
/// It exists before the upload finishes, because the chip has to appear the
/// instant a photo is chosen — waiting for a round trip to show anything makes
/// the picker feel broken on a slow tailnet.
@MainActor
@Observable
final class ComposerAttachment: Identifiable {
  enum State {
    case uploading
    /// Uploaded; `id` is what the message will name.
    case ready(remoteId: String)
    case failed(String)
  }

  let id = UUID()
  let name: String
  let mediaType: String
  let bytes: Int
  /// Rendered locally — the phone already has the pixels, so a chip never waits
  /// on a download to show what it is.
  let thumbnail: UIImage?
  private(set) var state: State = .uploading
  /// Kept so a failed upload can be retried without re-picking the file.
  let data: Data

  init(name: String, mediaType: String, bytes: Int, thumbnail: UIImage?, data: Data) {
    self.name = name
    self.mediaType = mediaType
    self.bytes = bytes
    self.thumbnail = thumbnail
    self.data = data
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

/// The composer's staging area: pick → normalize → upload → hand ids to `send`.
///
/// Uploading eagerly (rather than at send time) is what keeps the send button
/// instant: by the time a message is typed, its photos are already on the
/// gateway, and the command carries three short ids.
@MainActor
@Observable
final class ComposerAttachmentStore {
  private(set) var items: [ComposerAttachment] = []
  var errorText: String?

  /// Set by the session view once the client and id are known.
  var upload: (@Sendable (String, String, Data) async throws -> MessageAttachment)?

  var isEmpty: Bool { items.isEmpty }
  /// True while anything is still in flight — send waits for it rather than
  /// dropping the attachment that had not landed yet.
  var isUploading: Bool {
    items.contains { if case .uploading = $0.state { return true } else { return false } }
  }
  /// A failed upload blocks the send rather than being dropped from it — the chip
  /// is right there with a retry and an ✕, and a message that silently lost its
  /// picture is the failure this whole path is built to avoid.
  var hasFailure: Bool { items.contains { $0.failure != nil } }

  /// Ids in composer order, for the message about to be sent.
  var readyIds: [String] { items.compactMap(\.remoteId) }

  func add(_ picked: PickedFile) {
    let item = ComposerAttachment(
      name: picked.name,
      mediaType: picked.mediaType,
      bytes: picked.data.count,
      thumbnail: picked.thumbnail,
      data: picked.data)
    items.append(item)
    send(item, announceFailure: true)
  }

  /// Retry one that failed — tapping the chip. Silent on failure the second time:
  /// the alert has already been seen and the badge is still there.
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
    Task {
      do {
        let uploaded = try await upload(item.name, item.mediaType, item.data)
        item.settle(.ready(remoteId: uploaded.id))
      } catch {
        let message = (error as? WorkerClientError)?.message ?? error.localizedDescription
        item.settle(.failed(message))
        if announceFailure { errorText = message }
      }
    }
  }

  func remove(_ item: ComposerAttachment) {
    items.removeAll { $0.id == item.id }
  }

  /// After a successful send. The bytes live on the server now and the message
  /// event carries the references, so the staging area starts empty again.
  func clear() { items.removeAll() }
}

/// A file the user picked, normalized to something a model can be shown.
struct PickedFile {
  let name: String
  let mediaType: String
  let data: Data
  let thumbnail: UIImage?
}

enum AttachmentNormalizer {
  /// The API's image types. An iPhone's own photos are usually HEIC, which is
  /// not among them — so a photo is transcoded here rather than rejected by the
  /// gateway with a media type the user never chose.
  static let acceptedImageTypes: Set<String> = ["image/jpeg", "image/png", "image/gif", "image/webp"]

  /// Longest edge a photo is scaled to before upload.
  ///
  /// Vision models resize to roughly this internally, so anything larger costs
  /// upload time on a phone connection and buys no detail. It also keeps a
  /// burst of camera-roll photos well inside the session's byte ceiling.
  static let maxImageEdge: CGFloat = 1568
  static let jpegQuality: CGFloat = 0.8

  /// Normalize an image: transcode when the format isn't one the API takes, and
  /// downscale when it is bigger than the model will use.
  static func image(_ image: UIImage, name: String, mediaType: String?) -> PickedFile? {
    let scaled = downscaled(image)
    // A format the API accepts, and small enough already: keep the original
    // bytes rather than re-encoding (a second JPEG pass only loses quality).
    if let mediaType, acceptedImageTypes.contains(mediaType), scaled === image,
      let data = original(of: image, mediaType: mediaType)
    {
      return PickedFile(name: name, mediaType: mediaType, data: data, thumbnail: thumbnail(scaled))
    }
    guard let data = scaled.jpegData(compressionQuality: jpegQuality) else { return nil }
    return PickedFile(
      name: renamed(name, to: "jpg"), mediaType: "image/jpeg", data: data,
      thumbnail: thumbnail(scaled))
  }

  /// Normalize raw picked bytes (Photos or Files). Images go through `image` so
  /// the HEIC and oversize rules apply wherever they came from; everything else
  /// is passed through and left to the gateway to accept or refuse.
  static func file(data: Data, name: String, mediaType: String) -> PickedFile? {
    if mediaType.hasPrefix("image/"), let image = UIImage(data: data) {
      // Already an accepted type at a sane size: send the exact bytes.
      if acceptedImageTypes.contains(mediaType), downscaled(image) === image {
        return PickedFile(name: name, mediaType: mediaType, data: data, thumbnail: thumbnail(image))
      }
      return self.image(image, name: name, mediaType: mediaType)
    }
    return PickedFile(name: name, mediaType: mediaType, data: data, thumbnail: nil)
  }

  /// IANA type for a picked file, from its extension. Unknown extensions come
  /// back as octet-stream, which the gateway refuses with a clear message —
  /// better than guessing text/plain and feeding the model bytes.
  static func mediaType(for url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
  }

  /// Textual types whose media type doesn't start with `text/` — mirror of
  /// core's list, used only to *classify*, never to refuse: an unknown type
  /// still goes to the gateway, whose vocabulary is authoritative.
  private static let textTypes: Set<String> = [
    "application/json", "application/xml", "application/yaml", "application/x-yaml",
    "application/toml", "application/javascript", "application/typescript",
    "application/x-sh", "application/x-httpd-php", "application/sql",
  ]

  /// The capability-record kind ('image' | 'pdf' | 'text') this media type
  /// lands as, or nil when the classification is unknown here. Any `image/*`
  /// counts as image — this normalizer transcodes what the API wouldn't take.
  static func kind(of mediaType: String) -> String? {
    let type =
      mediaType.split(separator: ";").first.map {
        $0.trimmingCharacters(in: .whitespaces).lowercased()
      } ?? mediaType.lowercased()
    if type.hasPrefix("image/") { return "image" }
    if type == "application/pdf" { return "pdf" }
    if type.hasPrefix("text/") || textTypes.contains(type) { return "text" }
    return nil
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

  private static func original(of image: UIImage, mediaType: String) -> Data? {
    mediaType == "image/png" ? image.pngData() : image.jpegData(compressionQuality: jpegQuality)
  }

  private static func thumbnail(_ image: UIImage) -> UIImage {
    let format = UIGraphicsImageRendererFormat.default()
    let side: CGFloat = 120
    let scale = side / max(image.size.width, image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  private static func renamed(_ name: String, to ext: String) -> String {
    let stem = (name as NSString).deletingPathExtension
    return (stem.isEmpty ? "photo" : stem) + "." + ext
  }
}

import SwiftUI
import UIKit
import WorkerDeckKit

/// Project icon bytes for the sessions list, keyed by the icon's own **content
/// hash**.
///
/// `SessionInfo.project` carries an *address* — media type, byte count, and a
/// sha256 of the bytes — never the picture. The bytes come from
/// `GET /sessions/:id/project/icon`, which is session-scoped so the fetch rides
/// the same authorization gate as every other session route.
///
/// **Keyed by hash, not by session or by project**, which is what the hash is on
/// the wire for: every session in one project serves identical bytes, so twelve
/// rows of one repo cost one request. Two *different* projects that happen to
/// declare the same file cost one between them, and so do two gateways serving
/// the same checkout — content addressing makes both fall out rather than
/// needing a rule.
///
/// **Cached for the life of the process, deliberately.** A hash names its bytes,
/// so an entry can never go stale: editing the icon changes the hash, which
/// arrives on the next poll as a key this loader has not seen. The old entry is
/// dead weight rather than a wrong answer, and the population is bounded by how
/// many distinct icons an operator has open.
///
/// **A failure is cached as a failure.** The route's 404 is the uniform "no
/// icon" — no project, a glyph-only project, or an icon the gateway refused —
/// so retrying would be a request per session per poll for a picture that is
/// never coming. `failed` is what keeps the miss as cheap as the hit.
///
/// Through the client rather than an `AsyncImage`, for `ProducedImageLoader`'s
/// two reasons: the gateway authenticates with a header, and a list re-renders
/// far too often to re-fetch on each pass.
///
/// ## SVG does not render here, and that is a platform limit
///
/// The wire allows `image/png` and `image/svg+xml`. Apple has no SVG decoder
/// reachable from bytes: `CGImageSourceCopyTypeIdentifiers()` lists 62 types and
/// none is SVG (asset catalogs accept SVG, but that is a *compile-time*
/// conversion of a file in the app bundle, not something a downloaded blob can
/// use). Rendering one would take a third-party rasteriser — this app has
/// **zero third-party Swift dependencies** and that is a standing rule — or an
/// offscreen `WKWebView` snapshot.
///
/// So an SVG icon is fetched, fails to decode, and is cached as a failure like
/// any other refusal: the project's **name still renders**, which is the same
/// degradation as a gateway that refused the icon. Attempt-and-fail rather than
/// skipping by media type on purpose — it costs one request per distinct icon
/// for the life of the process, and it starts working by itself if Apple ever
/// ships a decoder, where a hardcoded skip would need someone to notice.
///
/// A repo that wants its mark on the phone should declare a **PNG**. The
/// `WKWebView` route is viable if that is not good enough — the fetch is already
/// once-per-hash-forever, so it would be one offscreen render per distinct icon
/// per launch rather than per row — but it is a real piece of machinery and has
/// not been built.
///
/// This is the third implementation of the same three-set structure — the VS
/// Code extension host and the web `useProjectIcons` have the others — and they
/// genuinely cannot be shared: the difference is the transport each client is
/// allowed (a webview has no external `connect-src` at all and must be *handed*
/// data URLs). One design, three homes, for a reason that lives below all of
/// them.
@MainActor
@Observable
final class ProjectIconLoader {
  /// One icon worth fetching: which gateway, which session to ask through, and
  /// the hash that will key the result.
  struct Request: Hashable, Sendable {
    let hostId: UUID
    let sessionId: String
    let hash: String
  }

  private var images: [String: UIImage] = [:]
  private var inFlight: Set<String> = []
  private var failed: Set<String> = []

  /// The picture for a hash, or nil while it is unfetched, in flight, or
  /// refused. Every one of those renders the same way: the project's name is
  /// already on the row, so there is nothing to stand in for.
  func image(forHash hash: String) -> UIImage? { images[hash] }

  /// Note what this list needs and fetch whatever is missing, in the background.
  ///
  /// Called on every snapshot, so the common path is a walk that finds nothing
  /// new. Results arrive by mutating observed state, never by making the caller
  /// wait: a list must draw before its pictures do.
  /// The client resolver is passed per call rather than stored: the list model
  /// already owns the per-gateway clients (`context(for:)`), and holding its
  /// closure here would be both a retain cycle and a second place gateway
  /// credentials are assembled.
  func ensure(_ requests: some Sequence<Request>, clientFor: (UUID) -> WorkerClient?) {
    for request in requests {
      let hash = request.hash
      guard images[hash] == nil, !inFlight.contains(hash), !failed.contains(hash) else { continue }
      // An unreachable gateway is not an iconless one: fall out without
      // recording a failure, so the next poll tries again once it is back.
      guard let client = clientFor(request.hostId) else { continue }
      inFlight.insert(hash)
      Task { [weak self] in
        defer { self?.inFlight.remove(hash) }
        do {
          let data = try await client.projectIcon(sessionId: request.sessionId)
          // A decode failure is the same answer as a refusal: the gateway caps
          // and re-checks these, but nothing promises UIKit can read the result.
          guard let image = UIImage(data: data) else {
            self?.failed.insert(hash)
            return
          }
          // Stored **display-ready**, scaled once here rather than per render.
          // The row draws this glyph inline inside a `Text` run (see
          // `SessionRowView.projectIconText`), and a `Text(Image(uiImage:))`
          // renders at the image's own point size — there is no `.frame` to
          // constrain it, because it is a character in a line rather than a
          // view in a stack. A checked-in logo is whatever the repo committed,
          // so an unresized one would set a 512pt line. Once per fetch, keyed
          // by the same hash the picture is cached under.
          self?.images[hash] = image.fittedToProjectGlyphBox()
        } catch {
          self?.failed.insert(hash)
        }
      }
    }
  }
}

extension UIImage {
  /// Aspect-fit into the 16pt box the project glyph occupies on a session row —
  /// the same box as the engine mark one column over.
  ///
  /// Aspect-**fit**, never fill: a declared icon is whatever the repo checked
  /// in, and a squashed logo reads worse than a letterboxed one. The renderer's
  /// scale comes from the trait environment, so this is a point-size resize and
  /// stays sharp on a 3x screen.
  func fittedToProjectGlyphBox(_ box: CGFloat = 16) -> UIImage {
    let ratio = min(box / size.width, box / size.height)
    // Never scale *up*: a 12pt favicon blown to 16 is a blurry 12pt favicon.
    guard ratio < 1 else { return self }
    let target = CGSize(width: size.width * ratio, height: size.height * ratio)
    return UIGraphicsImageRenderer(size: target).image { _ in
      draw(in: CGRect(origin: .zero, size: target))
    }
  }
}

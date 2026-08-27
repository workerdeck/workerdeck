import SwiftUI
import UIKit
import WorkerDeckKit

/// lucide glyph names → SF Symbols, for `ProjectIcon`'s `glyph` arm.
///
/// **This is a vocabulary translation, not a bundle-size trade.** The web
/// clients curate a lucide subset because importing all ~1,600 costs 927 KB
/// against 77 KB (measured on the VS Code sidebar's bundle). Here the reason is
/// different and more absolute: lucide does not exist on this platform at all.
/// A `.workerdeck.json` declares a *lucide* name because the gateway validates
/// lucide's shape and has no icon catalog of its own, so the phone's only
/// options are to translate or to draw nothing.
///
/// Every name on the right was validated against this machine's
/// `CoreGlyphs.bundle/symbol_order.plist` (8,302 symbols), because a guessed SF
/// Symbol name is not a compile error — it renders **nothing**, silently, and
/// looks like a layout bug rather than a typo.
///
/// That validation cannot cover the other half, though: this Mac's catalog is
/// newer than the app's iOS 17 floor, so a name valid here may be absent on a
/// phone (`arrow.trianglehead.branch` needs iOS 18). Hence `projectSymbol` asks
/// **UIKit at runtime** rather than trusting the table — `UIImage(systemName:)`
/// answers nil for a symbol this OS does not have, which turns an
/// unrepresentable glyph into the folder fallback instead of a hole. It is the
/// same fallback an unmapped-but-well-formed name gets, which is the behaviour
/// protocol's `ProjectIcon` explicitly requires of every client.
///
/// Some of these are approximations, and deliberately so: SF has no rocket
/// (`paperplane`), no ghost (`theatermasks`) and no terminal outside
/// `apple.terminal`. A near neighbour beats a folder; a *wrong* neighbour does
/// not, which is why nothing here maps to something that reads as a status.
private let lucideToSFSymbol: [String: String] = [
  "anchor": "water.waves",
  "atom": "atom",
  "beaker": "testtube.2",
  "bike": "bicycle",
  "binary": "number",
  "blocks": "square.grid.2x2",
  "bot": "cpu",
  "box": "shippingbox",
  "brain": "brain",
  "briefcase": "briefcase",
  "brush": "paintbrush",
  "bug": "ant",
  "building-2": "building.2",
  "cable": "cable.connector",
  "camera": "camera",
  "car": "car",
  "cat": "cat",
  "circuit-board": "cpu",
  "cloud": "cloud",
  "code": "chevron.left.forwardslash.chevron.right",
  "coffee": "cup.and.saucer",
  "cog": "gearshape",
  "compass": "safari",
  "container": "shippingbox",
  "cpu": "cpu",
  "credit-card": "creditcard",
  "database": "cylinder.split.1x2",
  "diamond": "diamond",
  "dog": "dog",
  "feather": "pencil.tip",
  "film": "film",
  "flame": "flame",
  "flask-conical": "flask",
  "folder": "folder",
  "gamepad-2": "gamecontroller",
  "gauge": "gauge.with.dots.needle.bottom.50percent",
  "gem": "diamond",
  "ghost": "theatermasks",
  "gift": "gift",
  "git-branch": "arrow.trianglehead.branch",
  "globe": "globe",
  "graduation-cap": "graduationcap",
  "hammer": "hammer",
  "hexagon": "hexagon",
  "house": "house",
  "image": "photo",
  "key": "key",
  "landmark": "building.columns",
  "laptop": "laptopcomputer",
  "layers": "square.3.layers.3d",
  "leaf": "leaf",
  "library": "books.vertical",
  "lightbulb": "lightbulb",
  "lock": "lock",
  "mail": "envelope",
  "map": "map",
  "message-circle": "message",
  "mic": "microphone",
  "monitor": "desktopcomputer",
  "moon": "moon",
  "mountain": "mountain.2",
  "music": "music.note",
  "network": "network",
  "newspaper": "newspaper",
  "notebook": "text.book.closed",
  "orbit": "circle.dotted",
  "package": "shippingbox",
  "palette": "paintpalette",
  "pen-tool": "pencil.tip",
  "phone": "phone",
  "piggy-bank": "dollarsign.circle",
  "plane": "airplane",
  "plug": "powerplug",
  "puzzle": "puzzlepiece",
  "radar": "dot.radiowaves.left.and.right",
  "radio": "antenna.radiowaves.left.and.right",
  "receipt": "receipt",
  "rocket": "paperplane",
  "ruler": "ruler",
  "satellite": "antenna.radiowaves.left.and.right",
  "scale": "scalemass",
  "scissors": "scissors",
  "server": "server.rack",
  "shield": "shield",
  "ship": "sailboat",
  "shopping-cart": "cart",
  "signal": "chart.bar",
  "smartphone": "iphone",
  "sparkles": "sparkles",
  "sprout": "leaf",
  "square": "square",
  "star": "star",
  "sun": "sun.max",
  "table": "tablecells",
  "tag": "tag",
  "target": "target",
  "telescope": "binoculars",
  "terminal": "apple.terminal",
  "test-tube": "testtube.2",
  "tree-pine": "tree",
  "trophy": "trophy",
  "truck": "truck.box",
  "umbrella": "umbrella",
  "users": "person.2",
  "wallet": "wallet.pass",
  "wand": "wand.and.rays",
  "waves": "water.waves",
  "webhook": "link",
  "wifi": "wifi",
  "wrench": "wrench.adjustable",
  "zap": "bolt",]

/// The SF Symbol for a lucide glyph name, or `folder` when this build cannot
/// draw it — unmapped, or mapped to a symbol this OS is too old to have.
///
/// `folder` is the fallback rather than nothing because the row reserves no
/// space for an icon: drawing nothing is fine, but a *project* that has gone to
/// the trouble of declaring a glyph should still read as one.
func projectSymbol(forLucideName name: String) -> String {
  guard let symbol = lucideToSFSymbol[name], UIImage(systemName: symbol) != nil else {
    return "folder"
  }
  return symbol
}

/// A project's icon at list-row size — the render side of protocol's
/// `ProjectIcon`.
///
/// The two arms behave differently on purpose. A **glyph** takes the row's
/// colour, because it is a symbol in a line of text and SF Symbols are drawn
/// with the foreground style like any other. An **image** cannot: it is
/// somebody's brand mark, and tinting it would be misrepresenting it. That
/// asymmetry is the same one the web clients hit — an `<img>`-embedded SVG is
/// its own document and `currentColor` never reaches it — arrived at here from
/// the opposite direction and landing in the same place.
///
/// A declared image whose bytes have not arrived (or cannot be decoded — see
/// `ProjectIconLoader` on SVG) draws **nothing** rather than a placeholder box:
/// the project's name is already on the row, and a box that becomes a picture a
/// beat later is more movement than the picture is worth.
struct ProjectIconView: View {
  let icon: ProjectIcon
  /// Resolved bytes for the `image` arm. Nil while unfetched or undecodable.
  var image: UIImage?
  /// The box, both arms. **16 by default**, matching the engine mark's cell one
  /// column over: the design's own revision was to remove the icons' inner
  /// padding so the glyph fills its cell, and a project icon drawn smaller than
  /// the mark beside it re-creates exactly the gap that revision closed.
  /// `packages/ui`'s `ProjectIcon` defaults to 12, but that default is tuned for
  /// group headers, which is not this row.
  var size: CGFloat = 16

  var body: some View {
    switch icon {
    case .glyph(let name):
      Image(systemName: projectSymbol(forLucideName: name))
        .font(.system(size: size * 0.8))
        .foregroundStyle(.secondary)
        .frame(width: size)
    case .image:
      if let image {
        Image(uiImage: image)
          .resizable()
          // A declared icon is whatever aspect the repo checked in, and a
          // squashed logo reads worse than a letterboxed one.
          .aspectRatio(contentMode: .fit)
          .frame(width: size, height: size)
          // It is decoration beside a name, not a control.
          .accessibilityHidden(true)
      }
    }
  }
}

import PhotosUI
import SwiftUI
import UIKit
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The docked composer of the terminal theme: one rule along the top, a gutter cell on the transcript's marker column
// (`$` in shell mode, a stop while busy, `+` to attach, else the prompt glyph), the field, and the send cell.
struct CoreComposer: View {
  let model: CoreSessionModel
  let scroll: TranscriptScrollModel
  private let carry: ComposerCarry?

  @State private var composer: ComposerModel
  @State private var draft = ""
  @State private var selection = NSRange(location: 0, length: 0)
  @State private var focused = false
  @State private var showMedia = false
  @State private var showCamera = false
  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoSelection: [PhotosPickerItem] = []
  @State private var now = Date()

  private static let cell: CGFloat = 32
  private static let gap: CGFloat = 8

  init(model: CoreSessionModel, scroll: TranscriptScrollModel, services: CoreComposerServices, carry: ComposerCarry? = nil) {
    self.model = model
    self.scroll = scroll
    self.carry = carry
    let carried = carry?.model.flatMap { $0.core === model.composer ? $0 : nil }
    let composer = carried ?? ComposerModel(core: model.composer, services: services)
    carry?.model = composer
    _composer = State(initialValue: composer)
    _draft = State(initialValue: carry?.draft ?? "")
  }

  var body: some View {
    _ = model.ui.composer.revision
    let view = composer.view(draft: draft, now: now)
    return VStack(spacing: 0) {
      if view.suggestionsOpen {
        PromptSuggestionList(suggestions: composer.suggestions, onAccept: accept)
      }
      Rectangle()
        .fill(view.shellMode ? TerminalPalette.color(.magenta) : Color.accentColor)
        .frame(height: 1)
      VStack(alignment: .leading, spacing: 6) {
        if !composer.chips.isEmpty && !view.shellMode { ComposerAttachmentStrip(model: composer) }
        HStack(alignment: .center, spacing: Self.gap) {
          gutter(view)
          field(view)
          ComposerGlyphCell(glyph: "\u{21B5}", label: view.sendLabel, action: { send(background: false) })
            .disabled(!view.canSend)
        }
        note(view)
      }
      .padding(.horizontal, 6)
      .padding(.top, 6)
      .padding(.bottom, 8)
    }
    .background(Color(.systemBackground).ignoresSafeArea(edges: .bottom))
    .animation(.easeOut(duration: 0.15), value: view.shellMode)
    .task(id: view.wakeAt) {
      guard let wakeAt = view.wakeAt else { return }
      let wait = Double(wakeAt) / 1000 - Date().timeIntervalSince1970
      if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
      guard !Task.isCancelled else { return }
      now = Date()
    }
    .sheet(isPresented: $showMedia) {
      AddMediaSheet(acceptsImages: view.attachmentKinds.contains("image"), onChoose: choose)
    }
    .fullScreenCover(isPresented: $showCamera) {
      CameraPicker { image in
        if let picked = AttachmentNormalizer.image(image, name: "photo.jpg") { composer.add(picked) }
      }
      .ignoresSafeArea()
    }
    .photosPicker(isPresented: $showPhotos, selection: $photoSelection, matching: .images)
    .onChange(of: photoSelection) { _, items in
      guard !items.isEmpty else { return }
      photoSelection = []
      items.forEach(loadPhoto)
    }
    .fileImporter(
      isPresented: $showFiles, allowedContentTypes: AttachmentNormalizer.importableTypes(Set(view.attachmentKinds)),
      allowsMultipleSelection: true
    ) { result in
      switch result {
      case .success(let urls): urls.forEach(loadFile)
      case .failure(let error): composer.announce(error.localizedDescription)
      }
    }
    .alert(
      "Attachment failed",
      isPresented: Binding(get: { composer.errorText != nil }, set: { if !$0 { composer.errorText = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(composer.errorText ?? "")
    }
    .onChange(of: model.insertion) { _, text in
      guard let text else { return }
      model.insertion = nil
      apply(composerInsert(draft: draft, text: text))
    }
    .task { await composer.pollPeers() }
    .onChange(of: draft) { _, text in carry?.draft = text }
  }

  @ViewBuilder
  private func gutter(_ view: ComposerView) -> some View {
    switch view.gutter {
    case .shell:
      ComposerGlyphCell(
        glyph: TerminalShell.glyph, label: "Leave shell mode", tint: TerminalPalette.color(.magenta), action: exitShell)
    case .interrupt:
      ComposerGlyphCell(
        glyph: "\u{2715}", label: "Interrupt", tint: TerminalPalette.color(.yellow), action: model.interrupt)
    case .addMedia:
      ComposerGlyphCell(glyph: "+", label: "Add media", action: { showMedia = true })
        .disabled(!view.enabled)
    case .prompt:
      Text(TermGlyph.prompt)
        .font(Font(ComposerTextView.font))
        .foregroundStyle(TerminalPalette.color(.blue))
        .frame(width: Self.cell, height: Self.cell)
        .accessibilityHidden(true)
    }
  }

  private func field(_ view: ComposerView) -> some View {
    ZStack(alignment: .leading) {
      if draft.isEmpty {
        Text(view.placeholder)
          .font(Font(ComposerTextView.font))
          .foregroundStyle(TerminalPalette.color(.faint))
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
      ComposerTextView(
        text: $draft, selection: $selection, isFocused: $focused, isEnabled: view.enabled, isShellMode: view.shellMode,
        tokens: { [composer] text in composer.tokens(text) },
        onEdit: { text, caret in composer.edit(text, cursor: caret.location) },
        onImagePaste: { pasteImage(view) },
        onLeadingTrigger: composer.leadingTrigger)
    }
    .frame(minHeight: Self.cell)
  }

  @ViewBuilder
  private func note(_ view: ComposerView) -> some View {
    Group {
      if let note = view.note {
        if note.kind == .sendNow {
          Button { send(background: true) } label: {
            Text(note.text)
              .foregroundStyle(TerminalPalette.color(.blue))
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.plain)
        } else {
          Text(note.text)
        }
      }
    }
    .font(.caption.monospaced())
    .foregroundStyle(TerminalPalette.color(.dim))
    .padding(.leading, Self.cell + Self.gap)
  }

  private func apply(_ edit: DraftEdit) {
    draft = edit.text
    selection = NSRange(location: Int(edit.cursor), length: 0)
  }

  // The phone's Escape: the `$` goes back in front of the draft.
  private func exitShell() { apply(composer.exitShell(draft)) }

  private func accept(_ index: Int) {
    if let edit = composer.accept(index, draft: draft, cursor: selection.location) { apply(edit) }
  }

  private func send(background: Bool) {
    guard let outgoing = composer.send(draft, background: background) else { return }
    switch outgoing {
    case .shell(let command):
      model.runShell(command)
    case .message(let text, let attachmentIds, let background):
      model.send(text, attachmentIds: attachmentIds)
      if background { model.backgroundTask() }
    }
    model.clearRecap()
    draft = ""
    selection = NSRange(location: 0, length: 0)
    focused = true
    scroll.scrollToBottom()
  }

  private func choose(_ source: AddMediaSheet.Source) {
    switch source {
    case .camera: showCamera = true
    case .photos: showPhotos = true
    case .files: showFiles = true
    }
  }

  // Raw bytes first: a screenshot is PNG, and decoding it to re-encode as JPEG only loses legibility.
  private func pasteImage(_ view: ComposerView) -> Bool {
    guard view.canAddMedia, view.enabled, view.attachmentKinds.contains("image") else { return false }
    let board = UIPasteboard.general
    guard board.hasImages else { return false }
    for (type, mediaType) in AttachmentNormalizer.pasteboardImageTypes {
      guard let data = board.data(forPasteboardType: type.identifier) else { continue }
      let name = "pasted.\(type.preferredFilenameExtension ?? "img")"
      guard let picked = AttachmentNormalizer.file(data: data, name: name, mediaType: mediaType) else { continue }
      composer.add(picked)
      return true
    }
    guard let image = board.image, let picked = AttachmentNormalizer.image(image, name: "pasted.jpg") else {
      return false
    }
    composer.add(picked)
    return true
  }

  private func loadPhoto(_ item: PhotosPickerItem) {
    Task {
      let mediaType = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
      let name = item.itemIdentifier.map { "photo-\($0.prefix(8)).jpg" } ?? "photo.jpg"
      guard let data = try? await item.loadTransferable(type: Data.self),
        let picked = AttachmentNormalizer.file(data: data, name: name, mediaType: mediaType)
      else {
        composer.announce("Could not read that photo.")
        return
      }
      composer.add(picked)
    }
  }

  // A Files pick is a security-scoped URL: the bytes are read inside the access window.
  private func loadFile(_ url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let mediaType = AttachmentNormalizer.mediaType(for: url)
    if let refusal = composer.refusal(mediaType: mediaType) {
      composer.announce(refusal)
      return
    }
    guard let data = try? Data(contentsOf: url),
      let picked = AttachmentNormalizer.file(data: data, name: url.lastPathComponent, mediaType: mediaType)
    else {
      composer.announce(unreadableFile(name: url.lastPathComponent))
      return
    }
    composer.add(picked)
  }
}

// A composer action as a character in a cell, the transcript's own glyph vocabulary. The cell is drawn only while
// the button can act, so a send with nothing to send is just the dim glyph.
private struct ComposerGlyphCell: View {
  let glyph: String
  let label: String
  var tint: Color?
  let action: () -> Void

  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    Button(action: action) {
      Text(glyph)
        .font(Font(ComposerTextView.font))
        .foregroundStyle(tint ?? TerminalPalette.color(isEnabled ? .bright : .dim))
    }
    .buttonStyle(ComposerGlyphCellStyle(filled: isEnabled))
    .accessibilityLabel(label)
  }
}

private struct ComposerGlyphCellStyle: ButtonStyle {
  let filled: Bool

  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: 5)
    configuration.label
      .frame(width: 32, height: 32)
      .background(
        shape.fill(filled ? TerminalPalette.cellFill : .clear)
          .overlay(shape.fill(configuration.isPressed ? TerminalPalette.pressedCell : .clear))
          .overlay(shape.strokeBorder(filled ? TerminalPalette.cellStroke : .clear, lineWidth: 0.7)))
      .contentShape(Rectangle())
  }
}

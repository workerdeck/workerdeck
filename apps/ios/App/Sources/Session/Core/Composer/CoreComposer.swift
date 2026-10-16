import PhotosUI
import SwiftUI
import UIKit
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// What the composer reaches over REST: uploads, the `@file` search and the `#` peer list. Absent pieces switch their
// feature off.
struct CoreComposerServices: Sendable {
  var upload: (@Sendable (String, String, Data) async throws -> MessageAttachment)?
  var findFiles: (@Sendable (_ cwd: String, _ query: String) async throws -> [HostFileMatch])?
  var listPeers: (@Sendable () async throws -> [PeerSession])?

  static func live(client: WorkerClient, sessionId: String) -> Self {
    Self(
      upload: { name, mediaType, data in
        try await client.uploadAttachment(sessionId: sessionId, name: name, mediaType: mediaType, data: data)
      },
      findFiles: { cwd, query in
        try await client.findHostFiles(in: cwd, matching: query, limit: PromptCompletionModel.fileSearchLimit).matches
      },
      listPeers: {
        PromptCompletionModel.peerSessions(try await client.listSessions(), excluding: sessionId)
      })
  }
}

// The docked composer of the terminal theme: one rule along the top, a gutter cell on the transcript's marker column
// (`$` in shell mode, a stop while busy, `+` to attach, else the prompt glyph), the field, and the send cell.
struct CoreComposer: View {
  let model: CoreSessionModel
  let scroll: TranscriptScrollModel
  let services: CoreComposerServices

  @State private var draft = ""
  @State private var selection = NSRange(location: 0, length: 0)
  @State private var focused = false
  @State private var shellMode = false
  @State private var attachments = ComposerAttachmentStore()
  @State private var completion = PromptCompletionModel()
  @State private var showMedia = false
  @State private var showCamera = false
  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoSelection: [PhotosPickerItem] = []

  private static let cell: CGFloat = 32
  private static let gap: CGFloat = 8

  var body: some View {
    let context = model.ui.composer
    VStack(spacing: 0) {
      if completion.isOpen && !shellMode {
        PromptSuggestionList(suggestions: completion.suggestions, onAccept: accept)
      }
      Rectangle()
        .fill(shellMode ? TerminalPalette.color(.magenta) : Color.accentColor)
        .frame(height: 1)
      VStack(alignment: .leading, spacing: 6) {
        if !attachments.isEmpty && !shellMode { ComposerAttachmentStrip(store: attachments) }
        HStack(alignment: .center, spacing: Self.gap) {
          gutter
          field
          ComposerGlyphCell(glyph: "\u{21B5}", label: shellMode ? "Run" : "Send", action: send)
            .disabled(!canSend)
        }
        note(context)
      }
      .padding(.horizontal, 6)
      .padding(.top, 6)
      .padding(.bottom, 8)
    }
    .background(Color(.systemBackground).ignoresSafeArea(edges: .bottom))
    .animation(.easeOut(duration: 0.15), value: shellMode)
    .sheet(isPresented: $showMedia) {
      AddMediaSheet(acceptsImages: context.attachmentKinds.contains("image"), onChoose: choose)
    }
    .fullScreenCover(isPresented: $showCamera) {
      CameraPicker { image in
        if let picked = AttachmentNormalizer.image(image, name: "photo.jpg", mediaType: nil) { attachments.add(picked) }
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
      isPresented: $showFiles, allowedContentTypes: AttachmentNormalizer.importableTypes(context.attachmentKinds),
      allowsMultipleSelection: true
    ) { result in
      switch result {
      case .success(let urls): urls.forEach(loadFile)
      case .failure(let error): attachments.errorText = error.localizedDescription
      }
    }
    .alert(
      "Attachment failed",
      isPresented: Binding(get: { attachments.errorText != nil }, set: { if !$0 { attachments.errorText = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(attachments.errorText ?? "")
    }
    .onAppear { attachments.upload = services.upload }
    .onChange(of: context.cwd, initial: true) { _, cwd in
      guard let cwd, let find = services.findFiles else {
        completion.findFiles = nil
        return
      }
      completion.findFiles = { query in try await find(cwd, query) }
    }
    .onChange(of: context.commands, initial: true) { _, commands in completion.commands = commands }
    .onChange(of: context.skills, initial: true) { _, skills in completion.skills = skills }
    // Polled slowly: a name is not a reading, and it only has to be right when the list opens.
    .task {
      guard let listPeers = services.listPeers else { return }
      while !Task.isCancelled {
        if let peers = try? await listPeers() { completion.peers = peers }
        try? await Task.sleep(for: .seconds(20))
      }
    }
  }

  private var enabled: Bool { model.ui.chrome?.enabled == true }
  private var busy: Bool { model.ui.chrome?.busy == true }
  private var canAddMedia: Bool { !model.ui.composer.attachmentKinds.isEmpty && !shellMode }

  // A picture on its own is a message, but not before its upload landed; in shell mode the line alone decides.
  private var canSend: Bool {
    guard enabled else { return false }
    let typed = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    if shellMode { return typed }
    guard !attachments.isUploading, !attachments.hasFailure else { return false }
    return typed || !attachments.isEmpty
  }

  @ViewBuilder
  private var gutter: some View {
    if shellMode {
      ComposerGlyphCell(
        glyph: TerminalShell.glyph, label: "Leave shell mode", tint: TerminalPalette.color(.magenta), action: exitShell)
    } else if busy {
      ComposerGlyphCell(
        glyph: "\u{2715}", label: "Interrupt", tint: TerminalPalette.color(.yellow), action: model.interrupt)
    } else if canAddMedia {
      ComposerGlyphCell(glyph: "+", label: "Add media", action: { showMedia = true })
        .disabled(!enabled)
    } else {
      Text(TermGlyph.prompt)
        .font(Font(ComposerTextView.font))
        .foregroundStyle(TerminalPalette.color(.blue))
        .frame(width: Self.cell, height: Self.cell)
        .accessibilityHidden(true)
    }
  }

  private var field: some View {
    ZStack(alignment: .leading) {
      if draft.isEmpty {
        Text(shellMode ? "Run a command on the host" : "Message")
          .font(Font(ComposerTextView.font))
          .foregroundStyle(TerminalPalette.color(.faint))
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
      ComposerTextView(
        text: $draft, selection: $selection, isFocused: $focused, isEnabled: enabled, isShellMode: shellMode,
        names: completion.names,
        onEdit: { text, caret in
          guard !shellMode else { return }
          completion.update(for: text, cursor: Range(caret, in: text)?.lowerBound)
        },
        onImagePaste: pasteImage,
        onLeadingTrigger: leadingTrigger)
    }
    .frame(minHeight: Self.cell)
  }

  @ViewBuilder
  private func note(_ context: CoreComposerContext) -> some View {
    let queued = model.ui.chrome?.queued ?? 0
    Group {
      if shellMode {
        Text("shell mode · tap $ to exit")
      } else if context.canSendNow && canSend {
        Button(action: sendNow) {
          Text("send now - moves the running command to the background")
            .foregroundStyle(TerminalPalette.color(.blue))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
      } else if queued > 0 {
        Text("\(queued) queued · sends when the turn ends")
      }
    }
    .font(.caption.monospaced())
    .foregroundStyle(TerminalPalette.color(.dim))
    .padding(.leading, Self.cell + Self.gap)
  }

  private func leadingTrigger(_ character: String) -> Bool {
    switch composerTrigger(character: character, isShellMode: shellMode, canRunShell: model.ui.canRunShell) {
    case .enter:
      shellMode = true
      completion.cancel()
      return true
    case .leave:
      shellMode = false
      return true
    case .pass:
      return false
    }
  }

  // The phone's Escape: the `$` goes back in front of the draft.
  private func exitShell() {
    shellMode = false
    draft = exitDraft(draft: draft)
    selection = NSRange(location: (draft as NSString).length, length: 0)
  }

  private func accept(_ suggestion: PromptCompletionModel.Suggestion) {
    let result = completion.accept(suggestion, in: draft, cursor: Range(selection, in: draft)?.lowerBound)
    draft = result.text
    selection = NSRange(location: result.cursor.utf16Offset(in: result.text), length: 0)
  }

  private func send() {
    guard canSend else { return }
    completion.cancel()
    if shellMode {
      model.runShell(draft)
      shellMode = false
    } else {
      model.send(draft, attachmentIds: attachments.readyIds)
      attachments.clear()
    }
    draft = ""
    selection = NSRange(location: 0, length: 0)
    focused = true
    scroll.scrollToBottom()
  }

  private func sendNow() {
    send()
    model.backgroundTask()
  }

  private func choose(_ source: AddMediaSheet.Source) {
    switch source {
    case .camera: showCamera = true
    case .photos: showPhotos = true
    case .files: showFiles = true
    }
  }

  // Raw bytes first: a screenshot is PNG, and decoding it to re-encode as JPEG only loses legibility.
  private func pasteImage() -> Bool {
    guard canAddMedia, enabled, model.ui.composer.attachmentKinds.contains("image") else { return false }
    let board = UIPasteboard.general
    guard board.hasImages else { return false }
    for (type, mediaType) in AttachmentNormalizer.pasteboardImageTypes {
      guard let data = board.data(forPasteboardType: type.identifier) else { continue }
      let name = "pasted.\(type.preferredFilenameExtension ?? "img")"
      guard let picked = AttachmentNormalizer.file(data: data, name: name, mediaType: mediaType) else { continue }
      attachments.add(picked)
      return true
    }
    guard let image = board.image, let picked = AttachmentNormalizer.image(image, name: "pasted.jpg", mediaType: nil)
    else { return false }
    attachments.add(picked)
    return true
  }

  private func loadPhoto(_ item: PhotosPickerItem) {
    Task {
      let mediaType = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
      let name = item.itemIdentifier.map { "photo-\($0.prefix(8)).jpg" } ?? "photo.jpg"
      guard let data = try? await item.loadTransferable(type: Data.self),
        let picked = AttachmentNormalizer.file(data: data, name: name, mediaType: mediaType)
      else {
        attachments.errorText = "Could not read that photo."
        return
      }
      attachments.add(picked)
    }
  }

  // A Files pick is a security-scoped URL: the bytes are read inside the access window.
  private func loadFile(_ url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let mediaType = AttachmentNormalizer.mediaType(for: url)
    if let kind = AttachmentNormalizer.kind(of: mediaType), !model.ui.composer.attachmentKinds.contains(kind) {
      attachments.errorText = "This session's engine does not take \(kind) attachments."
      return
    }
    guard let data = try? Data(contentsOf: url),
      let picked = AttachmentNormalizer.file(data: data, name: url.lastPathComponent, mediaType: mediaType)
    else {
      attachments.errorText = "Could not read \(url.lastPathComponent)."
      return
    }
    attachments.add(picked)
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

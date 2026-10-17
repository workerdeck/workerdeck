package bi.atomic.workerdeck.app.session

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ComposerView
import bi.atomic.workerdeck.core.ffi.DraftEdit
import bi.atomic.workerdeck.core.ffi.Gutter
import bi.atomic.workerdeck.core.ffi.NoteKind
import bi.atomic.workerdeck.core.ffi.Outgoing
import bi.atomic.workerdeck.core.ffi.Suggestion
import bi.atomic.workerdeck.core.ffi.TokenKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val CELL = 32.dp
private val GAP = 8.dp
private val TEXT_SIZE = 15.sp
private val SUGGESTIONS_HEIGHT = 240.dp

@Composable
fun tokenColor(kind: TokenKind): Color {
    val colors = Wd.colors
    return when (kind) {
        TokenKind.FILE -> colors.palette.toneNamed("blue")
        TokenKind.COMMAND -> colors.purple
        TokenKind.SKILL -> colors.orange
        TokenKind.SESSION -> colors.palette.toneNamed("green")
    }
}

// The docked composer of the iOS terminal theme: one accent rule along the top, a gutter cell on the transcript's
// marker column, the field, and the send cell. Every decision is the core composer's `view`.
@Composable
fun Composer(
    composer: ComposerModel,
    draft: TextFieldValue,
    onDraft: (TextFieldValue) -> Unit,
    onSend: (Outgoing) -> Unit,
    onInterrupt: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = Wd.colors
    val magenta = colors.palette.toneNamed("magenta")
    val ui by composer.ui.collectAsStateWithLifecycle()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val view = remember(ui.revision, draft.text, now) { composer.view(draft.text, maxOf(now, System.currentTimeMillis())) }
    LaunchedEffect(view.wakeAt) {
        val at = view.wakeAt ?: return@LaunchedEffect
        delay((at - System.currentTimeMillis()).coerceAtLeast(0))
        now = System.currentTimeMillis()
    }
    LaunchedEffect(composer) { composer.pollPeers() }
    val style = TextStyle(fontFamily = Wd.mono, fontSize = TEXT_SIZE, lineHeight = 21.sp, color = colors.primary)
    val hint = TextStyle(fontFamily = Wd.mono, fontSize = 12.sp, lineHeight = 16.sp, color = colors.secondary)
    val fileColor = tokenColor(TokenKind.FILE)
    val commandColor = tokenColor(TokenKind.COMMAND)
    val skillColor = tokenColor(TokenKind.SKILL)
    val sessionColor = tokenColor(TokenKind.SESSION)
    val tint = VisualTransformation { text ->
        val styled = buildAnnotatedString {
            append(text.text)
            for (token in composer.tokens(text.text)) {
                if (token.end.toInt() > text.length) continue
                val color = when (token.kind) {
                    TokenKind.FILE -> fileColor
                    TokenKind.COMMAND -> commandColor
                    TokenKind.SKILL -> skillColor
                    TokenKind.SESSION -> sessionColor
                }
                addStyle(SpanStyle(color = color), token.start.toInt(), token.end.toInt())
            }
        }
        TransformedText(styled, OffsetMapping.Identity)
    }

    fun apply(edit: DraftEdit) = onDraft(TextFieldValue(edit.text, TextRange(edit.cursor.toInt())))

    fun change(next: TextFieldValue) {
        if (draft.text.isEmpty() && next.text.isNotEmpty() && composer.leadingTrigger(next.text)) return
        onDraft(next)
        if (next.text != draft.text || next.selection != draft.selection) composer.edit(next.text, next.selection.end)
    }

    fun send(background: Boolean) {
        val outgoing = composer.send(draft.text, background) ?: return
        onSend(outgoing)
        onDraft(TextFieldValue())
    }

    val pickers = rememberAttachmentPickers(composer)
    var media by remember { mutableStateOf(false) }

    Column(modifier.fillMaxWidth().background(colors.background)) {
        if (view.suggestionsOpen) {
            SuggestionList(ui.suggestions) { index -> composer.accept(index, draft.text, draft.selection.end)?.let(::apply) }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(if (view.shellMode) magenta else colors.accent))
        if (ui.chips.isNotEmpty() && !view.shellMode) {
            AttachmentStrip(ui.chips, ui.thumbnails, composer::retry, composer::remove)
        }
        Row(
            Modifier.fillMaxWidth().padding(start = GAP, end = GAP, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(GAP),
        ) {
            when (view.gutter) {
                Gutter.SHELL -> GlyphCell("$", magenta, "Leave shell mode", onClick = { apply(composer.exitShell(draft.text)) })
                Gutter.INTERRUPT -> GlyphCell("✕", colors.palette.toneNamed("yellow"), "Interrupt", onClick = onInterrupt)
                Gutter.ADD_MEDIA -> Box {
                    GlyphCell("+", colors.primary, "Add media", onClick = if (view.enabled) ({ media = true }) else null)
                    DropdownMenu(expanded = media, onDismissRequest = { media = false }) {
                        if ("image" in view.attachmentKinds) {
                            DropdownMenuItem(text = { Text("Photos") }, onClick = {
                                media = false
                                pickers.photos()
                            })
                        }
                        DropdownMenuItem(text = { Text("Files") }, onClick = {
                            media = false
                            pickers.files(view.attachmentKinds)
                        })
                    }
                }
                Gutter.PROMPT -> GlyphCell("❯", colors.palette.toneNamed("blue"), null, onClick = null)
            }
            Box(Modifier.weight(1f).padding(vertical = 5.dp)) {
                if (draft.text.isEmpty()) {
                    Text(view.placeholder, style = style.copy(color = colors.tertiary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                BasicTextField(
                    value = draft,
                    onValueChange = ::change,
                    enabled = view.enabled,
                    textStyle = style,
                    cursorBrush = SolidColor(if (view.shellMode) magenta else colors.accent),
                    maxLines = 6,
                    visualTransformation = tint,
                    keyboardOptions = KeyboardOptions(capitalization = if (view.shellMode) KeyboardCapitalization.None else KeyboardCapitalization.Sentences),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = if (view.shellMode) "Shell command" else "Message" }
                        .onPreviewKeyEvent { event ->
                            event.type == KeyEventType.KeyDown && event.key == Key.Backspace && draft.text.isEmpty() && composer.leadingTrigger("")
                        },
                )
            }
            GlyphCell("↵", if (view.canSend) colors.primary else colors.tertiary, view.sendLabel, armed = view.canSend, onClick = if (view.canSend) ({ send(false) }) else null)
        }
        Note(view, hint) { send(true) }
    }
    ui.error?.let { message ->
        AlertDialog(
            onDismissRequest = composer::errorShown,
            title = { Text("Attachment failed") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = composer::errorShown) { Text("OK") } },
        )
    }
}

@Composable
private fun Note(view: ComposerView, style: TextStyle, onSendNow: () -> Unit) {
    val note = view.note ?: return
    val modifier = Modifier.padding(start = GAP + CELL + GAP, bottom = 8.dp)
    if (note.kind == NoteKind.SEND_NOW) {
        Text(
            note.text,
            style = style.copy(color = Wd.colors.palette.toneNamed("blue")),
            modifier = modifier.fillMaxWidth().clickable(onClick = onSendNow),
        )
    } else {
        Text(note.text, style = style, modifier = modifier)
    }
}

class AttachmentPickers(val photos: () -> Unit, val files: (List<String>) -> Unit)

@Composable
private fun rememberAttachmentPickers(composer: ComposerModel): AttachmentPickers {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    fun load(uris: List<Uri>) {
        scope.launch {
            for (uri in uris) {
                when (val result = withContext(Dispatchers.IO) { AttachmentReader.read(context.contentResolver, uri, composer::refusal) }) {
                    is PickResult.Picked -> composer.add(result.file)
                    is PickResult.Refused -> composer.announce(result.message)
                }
            }
        }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(), ::load)
    val documents = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), ::load)
    return remember(photos, documents) {
        AttachmentPickers(
            photos = { photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            files = { kinds -> documents.launch(AttachmentReader.documentTypes(kinds)) },
        )
    }
}

// The suggestion rows, drawn from the core's records. A fixed height, so the row under a finger does not move as the
// filter narrows.
@Composable
private fun SuggestionList(suggestions: List<Suggestion>, onAccept: (Int) -> Unit) {
    val colors = Wd.colors
    Column(Modifier.fillMaxWidth().height(SUGGESTIONS_HEIGHT).background(colors.background)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.separator))
        LazyColumn(Modifier.fillMaxWidth()) {
            itemsIndexed(suggestions, key = { _, s -> s.id }) { index, suggestion ->
                SuggestionRow(suggestion, Modifier.clickable { onAccept(index) })
                if (index < suggestions.size - 1) Box(Modifier.padding(start = 14.dp).fillMaxWidth().height(0.5.dp).background(colors.separator))
            }
        }
    }
}

@Composable
private fun SuggestionRow(suggestion: Suggestion, modifier: Modifier) {
    val colors = Wd.colors
    val mono = TextStyle(fontFamily = Wd.mono, fontSize = 14.sp, color = colors.primary)
    val small = TextStyle(fontSize = 11.sp, color = colors.secondary)
    Row(
        modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp).semantics { contentDescription = "Suggestion ${suggestion.title}" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val sigil = when (suggestion.kind) {
            TokenKind.FILE -> "@"
            TokenKind.COMMAND -> "/"
            TokenKind.SKILL -> "$"
            TokenKind.SESSION -> "#"
        }
        if (suggestion.kind != TokenKind.COMMAND) {
            Text(sigil, style = mono.copy(color = tokenColor(suggestion.kind)), modifier = Modifier.size(width = 14.dp, height = 20.dp))
        }
        Column(Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                val titleStyle = if (suggestion.kind == TokenKind.COMMAND) mono.copy(color = tokenColor(TokenKind.COMMAND)) else TextStyle(fontSize = 15.sp, color = colors.primary)
                Text(suggestion.title, style = titleStyle, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                suggestion.hint?.let { Text(it, style = small.copy(fontFamily = Wd.mono, color = colors.tertiary), maxLines = 1) }
            }
            suggestion.subtitle?.let {
                Text(
                    it,
                    style = if (suggestion.pathSubtitle) small.copy(fontFamily = Wd.mono) else small,
                    maxLines = 1,
                    overflow = if (suggestion.pathSubtitle) TextOverflow.StartEllipsis else TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun GlyphCell(glyph: String, tint: Color, label: String?, armed: Boolean = false, onClick: (() -> Unit)?) {
    val colors = Wd.colors
    val shape = RoundedCornerShape(7.dp)
    val base = Modifier.size(CELL)
    val framed = if (armed || (onClick != null && glyph != "↵")) {
        base.background(colors.raised, shape).border(0.5.dp, colors.separator, shape)
    } else {
        base
    }
    Box(
        framed
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .let { m -> if (label != null) m.semantics { contentDescription = label } else m },
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, color = tint, style = TextStyle(fontFamily = Wd.mono, fontSize = TEXT_SIZE))
    }
}

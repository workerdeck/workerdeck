package bi.atomic.workerdeck.app.session

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ComposerTrigger
import bi.atomic.workerdeck.core.ffi.composerTrigger
import bi.atomic.workerdeck.core.ffi.exitDraft

private val CELL = 32.dp
private val GAP = 8.dp
private val TEXT_SIZE = 15.sp

data class ComposerState(val draft: TextFieldValue = TextFieldValue(), val shellMode: Boolean = false)

// The docked composer of the iOS terminal theme: one accent rule along the top, a gutter cell on the transcript's
// marker column (prompt, stop while busy, `$` in shell mode), the field, and the send cell.
@Composable
fun Composer(
    state: ComposerState,
    onState: (ComposerState) -> Unit,
    busy: Boolean,
    enabled: Boolean,
    canRunShell: Boolean,
    queued: UInt,
    onSend: (text: String, shell: Boolean) -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = Wd.colors
    val magenta = colors.palette.toneNamed("magenta")
    val canSend = enabled && state.draft.text.isNotBlank()
    val style = TextStyle(fontFamily = Wd.mono, fontSize = TEXT_SIZE, lineHeight = 21.sp, color = colors.primary)
    val hint = TextStyle(fontFamily = Wd.mono, fontSize = 12.sp, lineHeight = 16.sp, color = colors.secondary)

    fun edit(next: TextFieldValue) {
        if (state.draft.text.isEmpty() && next.text.length == 1) {
            when (composerTrigger(next.text, state.shellMode, canRunShell)) {
                ComposerTrigger.ENTER -> return onState(state.copy(draft = TextFieldValue(), shellMode = true))
                else -> Unit
            }
        }
        onState(state.copy(draft = next))
    }

    fun leaveShell() {
        val text = exitDraft(state.draft.text)
        onState(ComposerState(TextFieldValue(text, TextRange(text.length)), shellMode = false))
    }

    fun send() {
        if (!canSend) return
        onSend(state.draft.text, state.shellMode)
        onState(ComposerState())
    }

    Column(modifier.fillMaxWidth().background(colors.background)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(if (state.shellMode) magenta else colors.accent))
        Row(
            Modifier.fillMaxWidth().padding(start = GAP, end = GAP, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(GAP),
        ) {
            when {
                state.shellMode -> GlyphCell("$", magenta, "Leave shell mode", onClick = ::leaveShell)
                busy -> GlyphCell("✕", colors.palette.toneNamed("yellow"), "Interrupt", onClick = onStop)
                else -> GlyphCell("❯", colors.palette.toneNamed("blue"), null, onClick = null)
            }
            Box(Modifier.weight(1f).padding(vertical = 5.dp)) {
                if (state.draft.text.isEmpty()) {
                    Text(
                        if (state.shellMode) "Run a command on the host" else "Message",
                        style = style.copy(color = colors.tertiary),
                    )
                }
                BasicTextField(
                    value = state.draft,
                    onValueChange = ::edit,
                    enabled = enabled,
                    textStyle = style,
                    cursorBrush = SolidColor(if (state.shellMode) magenta else colors.accent),
                    maxLines = 6,
                    keyboardOptions = KeyboardOptions(capitalization = if (state.shellMode) KeyboardCapitalization.None else KeyboardCapitalization.Sentences),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = if (state.shellMode) "Shell command" else "Message" }
                        .onPreviewKeyEvent { event ->
                            val backspaceOnEmpty = event.type == KeyEventType.KeyDown && event.key == Key.Backspace && state.draft.text.isEmpty()
                            if (backspaceOnEmpty && composerTrigger("", state.shellMode, canRunShell) == ComposerTrigger.LEAVE) {
                                onState(state.copy(shellMode = false))
                                true
                            } else {
                                false
                            }
                        },
                )
            }
            GlyphCell("↵", if (canSend) colors.primary else colors.tertiary, "Send", armed = canSend, onClick = if (canSend) ::send else null)
        }
        val note = when {
            state.shellMode -> "shell mode · tap $ to exit"
            queued > 0u -> "$queued queued · sends when the turn ends"
            else -> null
        }
        note?.let {
            Text(it, style = hint, modifier = Modifier.padding(start = GAP + CELL + GAP, bottom = 8.dp))
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

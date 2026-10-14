package bi.atomic.workerdeck.app.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key as HardKey
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ShellGrid
import bi.atomic.workerdeck.core.ShellRun
import bi.atomic.workerdeck.core.ffi.Key
import bi.atomic.workerdeck.core.ffi.imeEdit
import kotlin.math.floor

// The IME edits a scratch field whose changes are diffed against the last value: removed characters are backspaces,
// added ones are typed. The sentinel keeps a backspace on an empty line visible to the diff.
private const val SENTINEL = " "

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShellScreen(model: SessionModel, shellId: String, style: TextStyle, palette: Palette, onClose: () -> Unit) {
    val view by model.shell.collectAsStateWithLifecycle()
    val grid = view?.grid
    val close = {
        model.closeShell(shellId)
        onClose()
    }
    BackHandler(onBack = close)
    DisposableEffect(shellId) { onDispose { if (model.shell.value?.id == shellId) model.closeShell(shellId) } }
    var confirmKill by remember { mutableStateOf(false) }
    var controlArmed by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val colors = Wd.colors
    val send: (Key) -> Unit = { model.shellKey(shellId, it) }
    val type: (String) -> Unit = { text ->
        val points = text.codePointCount(0, text.length)
        when {
            controlArmed && points == 1 -> {
                controlArmed = false
                send(Key.Control(text))
            }
            text == "\n" -> send(Key.Enter)
            points > 1 -> model.shellPaste(shellId, text)
            else -> model.shellText(shellId, text)
        }
    }
    val ink = if (Wd.colors.dark) SHELL_INK_DARK else SHELL_INK_LIGHT
    Column(Modifier.fillMaxSize().background(palette.background).imePadding()) {
        CenterAlignedTopAppBar(
            title = { Text(grid?.title ?: "Shell", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
            actions = {
                if (grid?.running == true) TextButton(onClick = { confirmKill = true }) { Text("Kill", color = colors.red) }
            },
            colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = colors.background),
        )
        StatusLine(grid, style, palette)
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val density = LocalDensity.current
            val measurer = rememberTextMeasurer()
            val cell = remember(style) { measurer.measure("MMMMMMMMMM", style).size.width / 10f }
            val line = with(density) { style.lineHeight.toPx() }
            val padding = with(density) { 8.dp.toPx() }
            val cols = maxOf(floor((constraints.maxWidth - padding * 2) / cell).toInt(), 20)
            val rows = maxOf(floor(constraints.maxHeight / line).toInt(), 4)
            var opened by remember { mutableStateOf(false) }
            LaunchedEffect(cols, rows) {
                if (opened) model.resizeShell(shellId, cols, rows) else model.openShell(shellId, cols, rows)
                opened = true
            }
            var drag by remember { mutableFloatStateOf(0f) }
            Canvas(
                Modifier
                    .fillMaxSize()
                    .pointerInput(shellId) {
                        detectTapGestures {
                            if (model.shell.value?.grid?.canType == true) {
                                focus.requestFocus()
                                keyboard?.show()
                            }
                        }
                    }
                    .pointerInput(shellId, line) {
                        detectVerticalDragGestures(onDragEnd = { drag = 0f }) { _, delta ->
                            drag += delta
                            val lines = (drag / line).toInt()
                            if (lines != 0) {
                                drag -= lines * line
                                model.scrollShell(lines)
                            }
                        }
                    },
            ) {
                grid ?: return@Canvas
                // Until the core answers a resize, the grid can hold more rows or columns than the canvas, and
                // drawText throws for a box that starts outside it.
                grid.lines.forEachIndexed { index, runs ->
                    val y = index * line
                    if (y + line > size.height) return@forEachIndexed
                    var column = 0
                    for (run in runs) {
                        val x = padding + column * cell
                        if (column >= grid.cols || x + cell > size.width) break
                        val (fg, bg) = colorsOf(run, ink, palette.background)
                        bg?.let { drawRect(it, Offset(x, y), Size(run.columns * cell, line)) }
                        if (!run.hidden && run.text.isNotBlank()) {
                            drawText(
                                measurer,
                                run.text,
                                topLeft = Offset(x, y),
                                size = Size(minOf(run.columns * cell + cell, size.width - x), line),
                                style = style.copy(
                                    color = fg,
                                    fontWeight = if (run.bold) FontWeight.Bold else null,
                                    fontStyle = if (run.italic) FontStyle.Italic else null,
                                    textDecoration = decoration(run),
                                ),
                                softWrap = false,
                                maxLines = 1,
                            )
                        }
                        column += run.columns
                    }
                }
                val cursorLine = grid.totalLines - grid.rows + grid.cursorRow - grid.startLine
                if (grid.cursorVisible && cursorLine in grid.lines.indices) {
                    drawRect(ink.copy(alpha = 0.55f), Offset(padding + grid.cursorCol * cell, cursorLine * line), Size(cell, line))
                }
            }
            Keyboard(focus, type, send)
        }
        if (grid?.canType == true) {
            ControlStrip(
                controlArmed = controlArmed,
                onControl = { controlArmed = !controlArmed },
                onKey = { key ->
                    controlArmed = false
                    send(key)
                },
                onKeyboard = {
                    focus.requestFocus()
                    keyboard?.show()
                },
            )
        }
    }
    if (confirmKill) {
        AlertDialog(
            onDismissRequest = { confirmKill = false },
            title = { Text("Kill this shell?") },
            text = { Text("The process and everything it started are stopped. The output stays readable.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmKill = false
                    model.killShell(shellId)
                }) { Text("Kill", color = colors.red) }
            },
            dismissButton = { TextButton(onClick = { confirmKill = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun StatusLine(grid: ShellGrid?, style: TextStyle, palette: Palette) {
    val tint = if (grid?.running == true) palette.toneNamed("magenta") else palette.toneNamed("dim")
    Column {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("$", style = style, color = tint)
            Text(grid?.statusText.orEmpty(), style = style, color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (grid?.canType == true) Text("${grid.cols}x${grid.rows}", style = style, color = palette.toneNamed("faint"))
        }
        Box(Modifier.fillMaxWidth().height(0.5.dp).background(Wd.colors.separator))
    }
}

@Composable
private fun Keyboard(focus: FocusRequester, onText: (String) -> Unit, onKey: (Key) -> Unit) {
    var field by remember { mutableStateOf(TextFieldValue(SENTINEL, TextRange(SENTINEL.length))) }
    BasicTextField(
        value = field,
        onValueChange = { next ->
            val new = next.text
            val edit = imeEdit(field.text, new)
            repeat(edit.backspaces.toInt()) { onKey(Key.Backspace) }
            if (edit.text.isNotEmpty()) onText(edit.text)
            val settled = next.composition == null && (new.length < SENTINEL.length || new.length > 64)
            field = if (settled) TextFieldValue(SENTINEL, TextRange(SENTINEL.length)) else next
        },
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.None),
        textStyle = TextStyle(color = Color.Transparent),
        cursorBrush = SolidColor(Color.Transparent),
        modifier = Modifier
            .size(1.dp)
            .focusRequester(focus)
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val key = when (event.key) {
                    HardKey.Enter -> Key.Enter
                    HardKey.Tab -> Key.Tab
                    HardKey.Escape -> Key.Escape
                    HardKey.DirectionUp -> Key.Up
                    HardKey.DirectionDown -> Key.Down
                    HardKey.DirectionLeft -> Key.Left
                    HardKey.DirectionRight -> Key.Right
                    else -> null
                }
                key?.let(onKey)
                key != null
            },
    )
}

@Composable
private fun ControlStrip(controlArmed: Boolean, onControl: () -> Unit, onKey: (Key) -> Unit, onKeyboard: () -> Unit) {
    val colors = Wd.colors
    Column(Modifier.navigationBarsPadding()) {
        Box(Modifier.fillMaxWidth().height(0.5.dp).background(colors.separator))
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            StripKey("esc") { onKey(Key.Escape) }
            StripKey("tab") { onKey(Key.Tab) }
            StripKey("ctrl", active = controlArmed, onClick = onControl)
            StripKey("^C") { onKey(Key.Control("c")) }
            Spacer(Modifier.weight(1f))
            StripKey("↑") { onKey(Key.Up) }
            StripKey("↓") { onKey(Key.Down) }
            StripKey("←") { onKey(Key.Left) }
            StripKey("→") { onKey(Key.Right) }
            StripKey("⌨", onClick = onKeyboard)
        }
    }
}

@Composable
private fun StripKey(label: String, active: Boolean = false, onClick: () -> Unit) {
    val colors = Wd.colors
    val magenta = colors.palette.toneNamed("magenta")
    Box(
        Modifier
            .defaultMinSize(minWidth = 34.dp, minHeight = 30.dp)
            .background(if (active) magenta.copy(alpha = 0.3f) else colors.raised, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = if (active) magenta else colors.primary)
    }
}

// The web pane's xterm foreground and cursor, not the transcript's ink: a shell's colours are the program's.
private val SHELL_INK_LIGHT = Color(0xFF1F2328)
private val SHELL_INK_DARK = Color(0xFFD4D4D4)

private fun colorsOf(run: ShellRun, ink: Color, background: Color): Pair<Color, Color?> {
    fun word(value: Int): Color? = when (value and 0xFF000000.toInt()) {
        ShellRun.FOREGROUND -> ink
        ShellRun.BACKGROUND -> background
        ShellRun.RGB -> Color(0xFF000000.toInt() or (value and 0xFFFFFF))
        else -> null
    }
    val fg = word(run.fg) ?: ink
    return (if (run.dim) fg.copy(alpha = 0.6f) else fg) to word(run.bg)
}

private fun decoration(run: ShellRun): TextDecoration? = when {
    run.underline && run.strikethrough -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
    run.underline -> TextDecoration.Underline
    run.strikethrough -> TextDecoration.LineThrough
    else -> null
}

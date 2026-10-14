package bi.atomic.workerdeck.app.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ConnectionState
import bi.atomic.workerdeck.core.ffi.Metrics

private val FONT_SIZE = 13.sp
private val LINE_HEIGHT = 18.sp
private val SIDE_PADDING = 8.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(client: GatewayClient, sessionId: String, fallbackTitle: String, entry: Entry? = null, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val dark = isSystemInDarkTheme()
    val palette = remember(dark) { Palette.of(dark) }
    val style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = FONT_SIZE, lineHeight = LINE_HEIGHT, color = palette.fg)
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val images = remember(client, sessionId) { ToolImages(sessionId, client::bytes) }
    var viewing by remember { mutableStateOf<ViewedImage?>(null) }
    CompositionLocalProvider(LocalToolImages provides images, LocalOpenImage provides { viewing = it }) {
        BoxWithConstraints(Modifier.fillMaxSize().background(palette.background)) {
            val metrics = with(density) {
                val cell = measurer.measure("MMMMMMMMMM", style).size.width / 10.0
                Metrics(cell, LINE_HEIGHT.toPx().toDouble(), (maxWidth - SIDE_PADDING * 2 - RAIL_WIDTH).toPx().toDouble(), FONT_SIZE.toPx().toDouble())
            }
            val promptMaxHeight = maxOf(220.dp, maxHeight * 0.5f)
            val model = remember(client, sessionId) { SessionModel(client, sessionId, metrics, entry).also { images.host = it::hostImagePath } }
            DisposableEffect(model) { onDispose { model.close() } }
            val context = LocalContext.current
            val bookmarks = remember(client, sessionId) { SessionBookmarks(BookmarkStore.of(context), client.gateway.id, sessionId) }
            LaunchedEffect(metrics) { model.resize(metrics) }
            val bookmarkRevision by bookmarks.revision.collectAsStateWithLifecycle()
            LaunchedEffect(bookmarkRevision) { model.bookmarks(bookmarks.ids()) }
            val ui by model.ui.collectAsStateWithLifecycle()
            var draft by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue()) }
            var shellMode by rememberSaveable { mutableStateOf(false) }
            var picker by rememberSaveable { mutableStateOf<Picker?>(null) }
            var clearing by rememberSaveable { mutableStateOf(false) }
            val chrome = ui.chrome
            Column(Modifier.fillMaxSize().imePadding()) {
                SessionTopBar(ui.title ?: fallbackTitle, onBack, model::reconnect, onClearContext = if (chrome?.canClearContext == true) ({ clearing = true }) else null)
                ui.error?.let { Text(it, color = Wd.colors.red, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(12.dp)) }
                ui.progress?.let { p ->
                    val fraction = if (p.target > 0) (p.seq.toFloat() / p.target).coerceIn(0f, 1f) else 0f
                    LinearProgressIndicator(
                        progress = { fraction },
                        modifier = Modifier.fillMaxWidth().height(2.dp),
                        color = Wd.colors.accent,
                        trackColor = Color.Transparent,
                        drawStopIndicator = {},
                    )
                }
                if (ui.rows.isEmpty()) {
                    Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        if (ui.progress == null && ui.connection == ConnectionState.LIVE) {
                            Text("No messages yet", style = MaterialTheme.typography.bodyMedium, color = Wd.colors.tertiary)
                        }
                    }
                } else {
                    TranscriptList(
                        rows = ui.rows,
                        linesAt = ui::linesAt,
                        style = style,
                        lineHeight = LINE_HEIGHT,
                        cell = with(density) { metrics.cell.toFloat().toDp() },
                        sidePadding = SIDE_PADDING,
                        palette = palette,
                        onVisible = model::visible,
                        onPress = model::press,
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        jump = ui.jump,
                        menu = rememberRowMenuHost(model, bookmarks, inFrame = false),
                        rail = rememberRailHost(model, ui.rail, inFrame = false),
                    )
                }
                Column(Modifier.navigationBarsPadding()) {
                    ui.prompt?.let { prompt ->
                        PendingPrompt(
                            prompt = prompt,
                            planLines = ui.planLines,
                            style = style,
                            lineHeight = LINE_HEIGHT,
                            cell = metrics.cell,
                            palette = palette,
                            maxBodyHeight = promptMaxHeight,
                            actions = model,
                        )
                    }
                    StatusStrip(chrome, ui.connection, model::reconnect) { picker = it }
                    Composer(
                        state = ComposerState(draft, shellMode),
                        onState = {
                            draft = it.draft
                            shellMode = it.shellMode
                        },
                        busy = chrome?.busy == true,
                        enabled = chrome?.enabled != false,
                        canRunShell = chrome?.canRunShell == true,
                        queued = chrome?.queued ?: 0u,
                        onSend = { text, shell -> if (shell) model.runShell(text) else model.send(text) },
                        onStop = model::interrupt,
                    )
                }
            }
            val shell by model.shell.collectAsStateWithLifecycle()
            shell?.let { ShellScreen(model, it.id, style, palette, onClose = {}) }
            val frame by model.frame.collectAsStateWithLifecycle()
            frame?.let { FrameScreen(model, it, bookmarks, style, LINE_HEIGHT, SIDE_PADDING, metrics.cell, palette, promptMaxHeight) }
            if (clearing) {
                // Not destructive red: the old conversation stays resumable, same wording as the other clients.
                AlertDialog(
                    onDismissRequest = { clearing = false },
                    title = { Text("Clear the conversation?") },
                    text = { Text("The session keeps running and starts a fresh conversation. The old one stays resumable.") },
                    confirmButton = {
                        TextButton(onClick = {
                            clearing = false
                            model.clearContext()
                        }) { Text("Clear context") }
                    },
                    dismissButton = { TextButton(onClick = { clearing = false }) { Text("Cancel") } },
                )
            }
            picker?.let {
                PickerSheet(
                    picker = it,
                    models = ui.modelPicker,
                    modes = ui.modePicker,
                    onModel = model::setModel,
                    onEffort = model::setEffort,
                    onMode = model::setMode,
                    onDismiss = { picker = null },
                )
            }
        }
        viewing?.let { ImageViewer(it) { viewing = null } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionTopBar(title: String, onBack: () -> Unit, onReconnect: () -> Unit, onClearContext: (() -> Unit)?) {
    val colors = Wd.colors
    var menu by remember { mutableStateOf(false) }
    Column {
        CenterAlignedTopAppBar(
            title = {
                Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            },
            navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            },
            actions = {
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "Session actions") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text("Reconnect") },
                            onClick = {
                                menu = false
                                onReconnect()
                            },
                        )
                        onClearContext?.let { clear ->
                            DropdownMenuItem(
                                text = { Text("Clear context") },
                                onClick = {
                                    menu = false
                                    clear()
                                },
                            )
                        }
                    }
                }
            },
            colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = colors.background),
        )
        Box(Modifier.fillMaxWidth().height(0.5.dp).background(colors.separator))
    }
}

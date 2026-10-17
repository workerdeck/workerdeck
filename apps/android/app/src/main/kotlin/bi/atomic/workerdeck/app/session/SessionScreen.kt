package bi.atomic.workerdeck.app.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.text.TextRange
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
import bi.atomic.workerdeck.core.ffi.Outgoing
import bi.atomic.workerdeck.core.ffi.composerInsert

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
            var picker by rememberSaveable { mutableStateOf<Picker?>(null) }
            var clearing by rememberSaveable { mutableStateOf(false) }
            var meter by rememberSaveable { mutableStateOf<Meter?>(null) }
            var extrasSheet by rememberSaveable { mutableStateOf<ExtrasSheet?>(null) }
            val extras by model.extras.collectAsStateWithLifecycle()
            val chrome = ui.chrome
            Column(Modifier.fillMaxSize().imePadding()) {
                SessionTopBar(
                    ui.title ?: fallbackTitle,
                    onBack,
                    model::reconnect,
                    onClearContext = if (chrome?.canClearContext == true) ({ clearing = true }) else null,
                    onMeter = if (ui.usage != null) ({ meter = it }) else null,
                    contextMeter = ui.usage?.contextUsage == true,
                    sheets = listOfNotNull(
                        ExtrasSheet.INFO,
                        ExtrasSheet.FILES.takeIf { extras.files && extras.cwd != null },
                        ExtrasSheet.MCP.takeIf { extras.mcp },
                        ExtrasSheet.SKILLS.takeIf { extras.skills },
                    ),
                    onSheet = { extrasSheet = it },
                )
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
                        if (ui.progress == null && ui.connection == ConnectionState.LIVE) EmptyState(extras.cwd ?: chrome?.cwd, ui.canRunShell)
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
                    StatusStrip(chrome, ui.connection, ui.usage, model::reconnect, onPicker = { picker = it }, onMeter = { meter = it })
                    Composer(
                        composer = model.composer,
                        draft = draft,
                        onDraft = { draft = it },
                        onSend = { outgoing ->
                            when (outgoing) {
                                is Outgoing.Shell -> model.runShell(outgoing.command)
                                is Outgoing.Message -> {
                                    model.send(outgoing.text, outgoing.attachmentIds)
                                    if (outgoing.background) model.backgroundTask(null)
                                }
                            }
                        },
                        onInterrupt = model::interrupt,
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
            meter?.let { MeterSheet(it, ui.usage, model::refreshUsage) { meter = null } }
            val cwd = extras.cwd
            if (extrasSheet == ExtrasSheet.FILES && cwd != null) {
                HostFilesScreen(client, cwd) { extrasSheet = null }
            } else extrasSheet?.let { sheet ->
                ExtrasSheetHost(
                    sheet = sheet,
                    model = model,
                    chrome = chrome,
                    skills = ui.skills,
                    onUseSkill = { skill ->
                        val opener = skill.defaultPrompt?.trim()?.takeIf { it.isNotEmpty() } ?: "${'$'}${skill.name}"
                        val edit = composerInsert(draft.text, opener)
                        draft = TextFieldValue(edit.text, TextRange(edit.cursor.toInt()))
                        model.composer.edit(edit.text, edit.cursor.toInt())
                    },
                    onDismiss = { extrasSheet = null },
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
private fun SessionTopBar(
    title: String,
    onBack: () -> Unit,
    onReconnect: () -> Unit,
    onClearContext: (() -> Unit)?,
    onMeter: ((Meter) -> Unit)?,
    contextMeter: Boolean,
    sheets: List<ExtrasSheet>,
    onSheet: (ExtrasSheet) -> Unit,
) {
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
                        sheets.forEach { sheet ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        when (sheet) {
                                            ExtrasSheet.INFO -> "Session info"
                                            ExtrasSheet.FILES -> "Files"
                                            ExtrasSheet.MCP -> "MCP servers"
                                            ExtrasSheet.SKILLS -> "Skills"
                                        },
                                    )
                                },
                                onClick = {
                                    menu = false
                                    onSheet(sheet)
                                },
                            )
                        }
                        onMeter?.let { open ->
                            if (contextMeter) {
                                DropdownMenuItem(
                                    text = { Text("Context") },
                                    onClick = {
                                        menu = false
                                        open(Meter.CONTEXT)
                                    },
                                )
                            }
                            DropdownMenuItem(
                                text = { Text("Usage") },
                                onClick = {
                                    menu = false
                                    open(Meter.USAGE)
                                },
                            )
                        }
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

// Sheds its parts as the height shrinks (glyph, then path, then everything); promises only what this composer does.
@Composable
private fun EmptyState(cwd: String?, canRunShell: Boolean) {
    val colors = Wd.colors
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val height = maxHeight
        if (height < 130.dp) return@BoxWithConstraints
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (height >= 320.dp) {
                Box(Modifier.size(58.dp).background(colors.secondary.copy(alpha = 0.12f), RoundedCornerShape(18.dp)), contentAlignment = Alignment.Center) {
                    Text(">_", fontFamily = FontFamily.Monospace, fontSize = 20.sp, color = colors.secondary)
                }
            }
            if (height >= 230.dp && cwd != null) {
                Text(
                    cwd,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = colors.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.StartEllipsis,
                    modifier = Modifier.padding(horizontal = 24.dp),
                )
            }
            val hints = listOfNotNull("✎" to "Tell me what to do", ("$" to "Type $ to run a command on the host.").takeIf { canRunShell })
            Column(Modifier.padding(horizontal = 20.dp).fillMaxWidth().background(colors.secondary.copy(alpha = 0.10f), RoundedCornerShape(16.dp))) {
                hints.forEachIndexed { index, (glyph, text) ->
                    if (index > 0) Box(Modifier.padding(start = 46.dp).fillMaxWidth().height(0.5.dp).background(colors.separator))
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(glyph, fontFamily = FontFamily.Monospace, color = colors.secondary, modifier = Modifier.width(22.dp))
                        Text(text, style = MaterialTheme.typography.bodySmall, color = colors.secondary)
                    }
                }
            }
        }
    }
}

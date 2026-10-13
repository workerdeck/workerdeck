package bi.atomic.workerdeck.app.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import bi.atomic.workerdeck.app.ui.annotate
import bi.atomic.workerdeck.core.ffi.ConnectionState
import bi.atomic.workerdeck.core.ffi.Metrics
import kotlinx.coroutines.flow.distinctUntilChanged

private val FONT_SIZE = 13.sp
private val LINE_HEIGHT = 18.sp
private val SIDE_PADDING = 8.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(client: GatewayClient, sessionId: String, fallbackTitle: String, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val dark = isSystemInDarkTheme()
    val palette = remember(dark) { Palette.of(dark) }
    val style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = FONT_SIZE, lineHeight = LINE_HEIGHT, color = palette.fg)
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(Modifier.fillMaxSize().background(palette.background)) {
        val metrics = with(density) {
            val cell = measurer.measure("MMMMMMMMMM", style).size.width / 10.0
            Metrics(cell, LINE_HEIGHT.toPx().toDouble(), (maxWidth - SIDE_PADDING * 2).toPx().toDouble(), FONT_SIZE.toPx().toDouble())
        }
        val model = remember(client, sessionId) { SessionModel(client, sessionId, metrics) }
        DisposableEffect(model) { onDispose { model.close() } }
        LaunchedEffect(metrics) { model.resize(metrics) }
        val ui by model.ui.collectAsStateWithLifecycle()
        var draft by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue()) }
        var shellMode by rememberSaveable { mutableStateOf(false) }
        val chrome = ui.chrome
        Column(Modifier.fillMaxSize().imePadding()) {
            SessionTopBar(ui.title ?: fallbackTitle, onBack, model::reconnect)
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
            val list = rememberLazyListState()
            val count = ui.rows.size
            LaunchedEffect(list, count) {
                snapshotFlow { list.layoutInfo.visibleItemsInfo.map { it.index } }
                    .distinctUntilChanged()
                    .collect { indices ->
                        if (indices.isEmpty() || count == 0) return@collect
                        model.visible(count - 1 - indices.max(), count - 1 - indices.min())
                    }
            }
            if (count == 0) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (ui.progress == null && ui.connection == ConnectionState.LIVE) {
                        Text("No messages yet", style = MaterialTheme.typography.bodyMedium, color = Wd.colors.tertiary)
                    }
                }
            } else LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, reverseLayout = true) {
                items(count, key = { index -> ui.rows[count - 1 - index].key }) { index ->
                    val row = count - 1 - index
                    val layout = ui.rows[row]
                    val lines = ui.linesAt(row)
                    val height = with(density) { layout.height.toDp() }
                    val lineHeight = with(density) { LINE_HEIGHT.toDp() }
                    if (lines == null) {
                        Spacer(Modifier.height(height))
                    } else {
                        Column(Modifier.fillMaxWidth().height(height), verticalArrangement = Arrangement.Bottom) {
                            lines.forEachIndexed { at, line ->
                                Text(
                                    annotate(line, palette),
                                    style = style,
                                    softWrap = false,
                                    maxLines = 1,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(lineHeight)
                                        .background(palette.band(line.band))
                                        .padding(horizontal = SIDE_PADDING)
                                        .let { if (line.pressable) it.clickable { model.press(row, at) } else it },
                                )
                            }
                        }
                    }
                }
            }
            Column(Modifier.navigationBarsPadding()) {
                StatusStrip(chrome, ui.connection, model::reconnect)
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
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionTopBar(title: String, onBack: () -> Unit, onReconnect: () -> Unit) {
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
                    }
                }
            },
            colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = colors.background),
        )
        Box(Modifier.fillMaxWidth().height(0.5.dp).background(colors.separator))
    }
}

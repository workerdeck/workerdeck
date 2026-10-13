package bi.atomic.workerdeck.app.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.app.ui.Palette
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
        Scaffold(
            containerColor = palette.background,
            topBar = {
                TopAppBar(
                    title = { Text(ui.title ?: fallbackTitle, maxLines = 1) },
                    navigationIcon = { TextButton(onClick = onBack) { Text("‹ Back") } },
                    actions = { ConnectionBadge(ui.connection, model::reconnect) },
                )
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                ui.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(SIDE_PADDING)) }
                ui.progress?.let { p ->
                    val fraction = if (p.target > 0) (p.seq.toFloat() / p.target).coerceIn(0f, 1f) else 0f
                    LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
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
                LazyColumn(Modifier.fillMaxSize().padding(horizontal = SIDE_PADDING), state = list, reverseLayout = true) {
                    items(count, key = { index -> ui.rows[count - 1 - index].key }) { index ->
                        val row = count - 1 - index
                        val layout = ui.rows[row]
                        val lines = ui.linesAt(row)
                        val height = with(density) { layout.height.toDp() }
                        val lineHeight = with(density) { LINE_HEIGHT.toDp() }
                        if (lines == null) {
                            Spacer(Modifier.height(height))
                        } else {
                            Column(Modifier.fillMaxWidth().height(height), verticalArrangement = androidx.compose.foundation.layout.Arrangement.Bottom) {
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
                                            .let { if (line.pressable) it.clickable { model.press(row, at) } else it },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectionBadge(state: ConnectionState, onRetry: () -> Unit) {
    val label = when (state) {
        ConnectionState.LIVE -> return
        ConnectionState.CONNECTING -> "Connecting"
        ConnectionState.RECONNECTING -> "Reconnecting"
        ConnectionState.OFFLINE -> "Offline"
        ConnectionState.UNREACHABLE -> "Unreachable"
    }
    Box { TextButton(onClick = onRetry) { Text(label) } }
}

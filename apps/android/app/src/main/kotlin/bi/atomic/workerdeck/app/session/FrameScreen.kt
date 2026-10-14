package bi.atomic.workerdeck.app.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.FrameStrip

// The sub-agent takeover, the iOS shape: no composer (you talk to the session), but the approvals stay, since a
// sub-agent's own calls raise session-level requests. It never closes itself; a missing task says so.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FrameScreen(
    model: SessionModel,
    frame: FrameView,
    bookmarks: SessionBookmarks,
    style: TextStyle,
    lineHeight: TextUnit,
    sidePadding: Dp,
    cell: Double,
    palette: Palette,
    promptMaxHeight: Dp,
) {
    val taskId = frame.taskId
    val close = { model.closeFrame(taskId) }
    BackHandler(onBack = close)
    DisposableEffect(taskId) { onDispose { if (model.frame.value?.taskId == taskId) model.closeFrame(taskId) } }
    val ui by model.ui.collectAsStateWithLifecycle()
    val colors = Wd.colors
    val strip = frame.strip
    Surface(Modifier.fillMaxSize(), color = palette.background) {
        Column(Modifier.fillMaxSize()) {
            CenterAlignedTopAppBar(
                title = {
                    Text(strip?.name ?: "Sub-agent", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = colors.background),
            )
            Box(Modifier.fillMaxWidth().height(0.5.dp).background(colors.separator))
            if (strip?.text != null) StripLine(strip, style, cell, palette)
            val replaying = ui.progress
            when {
                replaying != null -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(Modifier.padding(bottom = 6.dp), color = colors.secondary)
                        Text("${replaying.seq} / ${replaying.target}", style = MaterialTheme.typography.labelSmall, color = colors.secondary)
                    }
                }
                strip != null && strip.text == null -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(
                        "This sub-agent's work is not in this transcript.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.secondary,
                        modifier = Modifier.padding(24.dp),
                    )
                }
                else -> TranscriptList(
                    rows = frame.rows,
                    linesAt = frame::linesAt,
                    style = style,
                    lineHeight = lineHeight,
                    sidePadding = sidePadding,
                    palette = palette,
                    onVisible = model::frameVisible,
                    onPress = model::framePress,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    menu = rememberRowMenuHost(model, bookmarks, inFrame = true),
                    rail = rememberRailHost(model, frame.rail, inFrame = true),
                )
            }
            Column(Modifier.navigationBarsPadding()) {
                ui.prompt?.let { prompt ->
                    PendingPrompt(
                        prompt = prompt,
                        planLines = ui.planLines,
                        style = style,
                        lineHeight = lineHeight,
                        cell = cell,
                        palette = palette,
                        maxBodyHeight = promptMaxHeight,
                        actions = model,
                    )
                }
            }
        }
    }
}

@Composable
private fun StripLine(strip: FrameStrip, style: TextStyle, cell: Double, palette: Palette) {
    val tint = when {
        strip.failed -> palette.toneNamed("red")
        strip.busy -> palette.toneNamed("mark")
        else -> palette.toneNamed("dim")
    }
    val gutter = with(LocalDensity.current) { (cell * 2).toFloat().toDp() }
    Column {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(strip.glyph, style = style, color = tint, modifier = Modifier.width(gutter))
            Text(strip.text.orEmpty(), style = style, color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.fillMaxWidth().height(0.5.dp).background(Wd.colors.separator))
    }
}

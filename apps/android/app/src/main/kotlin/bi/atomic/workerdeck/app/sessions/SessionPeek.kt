package bi.atomic.workerdeck.app.sessions

import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.app.session.LocalToolImages
import bi.atomic.workerdeck.app.session.SessionModel
import bi.atomic.workerdeck.app.session.ToolImages
import bi.atomic.workerdeck.app.session.TranscriptList
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.Metrics
import bi.atomic.workerdeck.core.ffi.SeenCounts

private val PEEK_SHAPE = RoundedCornerShape(14.dp)
private val PEEK_FONT = 11.sp
private val PEEK_LINE = 15.sp
private val PEEK_SIDE = 8.dp
private val PEEK_HEIGHT = 460.dp

class PeekAction(val label: String, val icon: ImageVector?, val enabled: Boolean = true, val danger: Boolean = false, val run: () -> Unit)

class PeekActions(val bar: List<PeekAction>, val sections: List<List<PeekAction>>)

// The long press: the live transcript, read-only, over a blurred list, with everything the card can do below it.
@Composable
fun SessionPeekOverlay(
    row: ListRow,
    client: GatewayClient?,
    actions: PeekActions,
    onSeen: (SeenCounts) -> Unit,
    onLeave: (SeenCounts?) -> Unit,
    onOpen: () -> Unit,
    onDismiss: () -> Unit,
) {
    BackHandler(onBack = onDismiss)
    val colors = Wd.colors
    val appear = remember { Animatable(0f) }
    LaunchedEffect(Unit) { appear.animateTo(1f, tween(180)) }
    val dim = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) 0.25f else 0.55f
    Box(
        Modifier.fillMaxSize()
            .graphicsLayer { alpha = appear.value }
            .background(Color.Black.copy(alpha = dim))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss)
            .testTag("peek"),
    ) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp).graphicsLayer {
                val scale = 0.94f + 0.06f * appear.value
                scaleX = scale
                scaleY = scale
            },
            verticalArrangement = Arrangement.Center,
        ) {
            val title = row.agent ?: row.title
            Column(
                Modifier.fillMaxWidth().weight(1f, fill = false).height(PEEK_HEIGHT).clip(PEEK_SHAPE)
                    .clickable(onClickLabel = "Open session", onClick = onOpen)
                    .semantics { contentDescription = "Peek at $title" },
            ) {
                if (client != null) {
                    PeekTranscript(client, row.sessionId, title, onSeen, onLeave)
                } else {
                    Box(Modifier.fillMaxWidth().height(120.dp).background(colors.surface), contentAlignment = Alignment.Center) {
                        Text(title, color = colors.secondary)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            ActionPanel(actions, onDismiss)
        }
    }
}

@Composable
private fun PeekTranscript(client: GatewayClient, sessionId: String, title: String, onSeen: (SeenCounts) -> Unit, onLeave: (SeenCounts?) -> Unit) {
    val dark = isSystemInDarkTheme()
    val palette = remember(dark) { Palette.of(dark) }
    val style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = PEEK_FONT, lineHeight = PEEK_LINE, color = palette.fg)
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val images = remember(client, sessionId) { ToolImages(sessionId, client::bytes) }
    val leave by rememberUpdatedState(onLeave)
    Column(Modifier.fillMaxSize().background(palette.background)) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val metrics = with(density) {
                val cell = measurer.measure("MMMMMMMMMM", style).size.width / 10.0
                Metrics(cell, PEEK_LINE.toPx().toDouble(), (maxWidth - PEEK_SIDE * 2).toPx().toDouble(), PEEK_FONT.toPx().toDouble())
            }
            val model = remember(client, sessionId) { SessionModel(client, sessionId, metrics).also { images.host = it::hostImagePath } }
            DisposableEffect(model) {
                onDispose {
                    leave(model.seen.value)
                    model.close()
                }
            }
            LaunchedEffect(metrics) { model.resize(metrics) }
            val seen by model.seen.collectAsStateWithLifecycle()
            LaunchedEffect(seen) { seen?.let(onSeen) }
            val ui by model.ui.collectAsStateWithLifecycle()
            Column(Modifier.fillMaxSize()) {
                Text(
                    ui.title ?: title,
                    color = Wd.colors.primary,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                )
                HorizontalDivider(color = Wd.colors.separator)
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    if (ui.rows.isEmpty()) {
                        CircularProgressIndicator(Modifier.align(Alignment.Center).size(24.dp), strokeWidth = 2.dp)
                    } else {
                        CompositionLocalProvider(LocalToolImages provides images) {
                            TranscriptList(
                                rows = ui.rows,
                                linesAt = ui::linesAt,
                                style = style,
                                lineHeight = PEEK_LINE,
                                cell = with(density) { metrics.cell.toFloat().toDp() },
                                sidePadding = PEEK_SIDE,
                                palette = palette,
                                onVisible = model::visible,
                                onPress = { _, _ -> },
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                    // Swallows every touch, so the transcript neither scrolls nor expands and a tap opens the session.
                    Box(Modifier.matchParentSize().pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } })
                }
            }
        }
    }
}

@Composable
private fun ActionPanel(actions: PeekActions, dismiss: () -> Unit) {
    val colors = Wd.colors
    Column(
        Modifier.widthIn(max = 280.dp).fillMaxWidth().clip(PEEK_SHAPE).background(colors.raised).verticalScroll(rememberScrollState())
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
    ) {
        if (actions.bar.isNotEmpty()) {
            Row(Modifier.fillMaxWidth()) {
                for (action in actions.bar) {
                    Column(
                        Modifier.weight(1f).clickable(enabled = action.enabled) {
                            dismiss()
                            action.run()
                        }.padding(vertical = 10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        val tint = if (action.enabled) colors.primary else colors.tertiary
                        action.icon?.let { Icon(it, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp)) }
                        Spacer(Modifier.height(4.dp))
                        Text(action.label, color = tint, fontSize = 12.sp)
                    }
                }
            }
        }
        actions.sections.filter { it.isNotEmpty() }.forEachIndexed { index, section ->
            if (index > 0 || actions.bar.isNotEmpty()) HorizontalDivider(thickness = if (index == 0) 0.5.dp else 6.dp, color = colors.separator)
            for (action in section) {
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = action.enabled) {
                        dismiss()
                        action.run()
                    }.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val tint = when {
                        !action.enabled -> colors.tertiary
                        action.danger -> colors.red
                        else -> colors.primary
                    }
                    Text(action.label, color = tint, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    action.icon?.let {
                        Spacer(Modifier.width(12.dp))
                        Icon(it, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
    }
}

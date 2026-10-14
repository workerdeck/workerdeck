package bi.atomic.workerdeck.app.session

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.core.LayoutRow
import bi.atomic.workerdeck.core.ffi.ScrubCluster
import bi.atomic.workerdeck.core.ffi.ScrubPeek
import bi.atomic.workerdeck.core.ffi.scrubBand
import bi.atomic.workerdeck.core.ffi.scrubHit
import bi.atomic.workerdeck.core.ffi.scrubOffset
import bi.atomic.workerdeck.core.ffi.scrubPad
import bi.atomic.workerdeck.core.ffi.scrubTarget
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

// The paint is the theme's 12; the finger gets a wider strip, still narrower than a 48 target because the rail sits
// where a right thumb scrolls the transcript.
val RAIL_WIDTH = 12.dp
private val HIT_WIDTH = 28.dp
private val PRESS_SLOP = 8.dp
private const val DRAG_SLOP_PX = 3f

// One surface's rail: its clusters (from the core, in layout pixels), the peek on it if any, and where its size and
// the finger go.
class RailHost(
    val clusters: List<ScrubCluster>,
    val peek: ScrubPeek?,
    val peekY: Double,
    val onSize: (railH: Double, viewportH: Double) -> Unit,
    val onPeek: (ScrubCluster?, Double) -> Unit,
)

// The bottom-anchored list's geometry from the top, which is how the core measures: `below[i]` is the height of the
// `i` list items under item `i` (item 0 is the newest row).
private class ListGeometry(rows: List<LayoutRow>) {
    val below = DoubleArray(rows.size + 1).also { sums ->
        for (i in rows.indices) sums[i + 1] = sums[i] + rows[rows.size - 1 - i].height
    }
    val count = rows.size
    val total get() = below[count]

    fun offset(list: LazyListState, viewportH: Double): Double {
        if (count == 0) return 0.0
        val first = list.firstVisibleItemIndex.coerceIn(0, count)
        return (total - viewportH - below[first] - list.firstVisibleItemScrollOffset).coerceAtLeast(0.0)
    }

    fun rowTop(row: Int): Double = total - below[(count - row).coerceIn(0, count)]

    fun scrollTo(scope: CoroutineScope, list: LazyListState, top: Double, viewportH: Double) {
        if (count == 0) return
        val fromBottom = (total - viewportH - top).coerceIn(0.0, (total - viewportH).coerceAtLeast(0.0))
        val found = java.util.Arrays.binarySearch(below, 0, count, fromBottom)
        val item = (if (found >= 0) found else -found - 2).coerceIn(0, count - 1)
        scope.launch { list.scrollToItem(item, (fromBottom - below[item]).toInt()) }
    }
}

@Composable
fun rememberRailHost(model: SessionModel, clusters: List<ScrubCluster>, inFrame: Boolean): RailHost {
    val peek by model.peek.collectAsStateWithLifecycle()
    val mine = peek?.takeIf { it.inFrame == inFrame }
    return RailHost(
        clusters = clusters,
        peek = mine?.peek,
        peekY = mine?.y ?: 0.0,
        onSize = { railH, viewportH -> model.railSize(railH, viewportH, inFrame) },
        onPeek = { cluster, y -> model.peek(cluster, y, inFrame) },
    )
}

@Composable
fun BoxScope.ScrubberRail(host: RailHost, rows: List<LayoutRow>, list: LazyListState, palette: Palette, style: TextStyle) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val geometry = remember(rows) { ListGeometry(rows) }
    val railW = with(density) { RAIL_WIDTH.toPx() }
    val hitW = with(density) { HIT_WIDTH.toPx() }
    val pressSlop = with(density) { PRESS_SLOP.toPx() }
    val railH = remember { mutableIntStateOf(0) }
    LaunchedEffect(railH.intValue) {
        if (railH.intValue > 0) host.onSize(railH.intValue.toDouble(), railH.intValue.toDouble())
    }
    val viewportH = railH.intValue.toDouble()
    val offset by remember(geometry, list, viewportH) { derivedStateOf { geometry.offset(list, viewportH) } }
    val pulse by rememberInfiniteTransition(label = "approval").animateFloat(
        initialValue = 1f,
        targetValue = 0.3f,
        animationSpec = infiniteRepeatable(tween(600, easing = LinearEasing), RepeatMode.Reverse),
        label = "approval",
    )
    val pad = scrubPad(viewportH, geometry.total, viewportH).toFloat()
    val currentPad by rememberUpdatedState(pad)
    val current by rememberUpdatedState(host)
    val currentGeometry by rememberUpdatedState(geometry)

    Box(Modifier.matchParentSize().onSizeChanged { railH.intValue = it.height }) {
        Canvas(Modifier.align(Alignment.TopEnd).width(RAIL_WIDTH).fillMaxHeight()) {
            translate(top = pad) { for (cluster in host.clusters) drawCluster(cluster, palette, if (cluster.kind == "approval") pulse else 1f) }
        }
        Canvas(Modifier.align(Alignment.TopEnd).width(RAIL_WIDTH).fillMaxHeight()) {
            val band = scrubBand(size.height.toDouble(), geometry.total, viewportH, offset)
            val faint = palette.toneNamed("faint")
            drawRect(faint.copy(alpha = 0.25f), Offset(0f, band.top.toFloat()), Size(size.width, band.h.toFloat()))
            drawRect(faint, Offset(0.5f, band.top.toFloat() + 0.5f), Size(size.width - 1f, (band.h.toFloat() - 1f).coerceAtLeast(0f)), style = Stroke(1f))
        }
        host.peek?.let { PeekPanel(it, host.peekY + pad, railH.intValue, palette, style) }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .width(HIT_WIDTH)
                .fillMaxHeight()
                .pointerInput(Unit) {
                    fun hit(position: Offset): ScrubCluster? =
                        scrubHit(current.clusters, (position.x - (hitW - railW)).toDouble(), (position.y - currentPad).toDouble(), railW.toDouble(), pressSlop.toDouble())
                            ?.let { current.clusters.getOrNull(it.toInt()) }
                    fun scrub(y: Float) {
                        val h = size.height.toDouble()
                        if (h <= 0) return
                        currentGeometry.scrollTo(scope, list, scrubOffset(y / h, currentGeometry.total, h), h)
                    }
                    var peeked: ScrubCluster? = null
                    var peekedY = 0.0
                    fun peekAt(position: Offset) {
                        val cluster = hit(position)
                        val y = cluster?.let { (position.y - currentPad).toDouble().coerceIn(it.y, it.y + it.h) } ?: 0.0
                        if (cluster == peeked && abs(y - peekedY) < 2) return
                        peeked = cluster
                        peekedY = y
                        current.onPeek(cluster, y)
                    }
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        down.consume()
                        var dragging = false
                        var last = down.position
                        peekAt(last)
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) break
                            last = change.position
                            if (!dragging && abs(last.y - down.position.y) >= DRAG_SLOP_PX) dragging = true
                            if (dragging) scrub(last.y)
                            peekAt(last)
                            change.consume()
                        }
                        peeked = null
                        current.onPeek(null, 0.0)
                        if (dragging) return@awaitEachGesture
                        val h = size.height.toDouble()
                        val cluster = hit(last)
                        val row = cluster?.let { scrubTarget(it, (last.y - currentPad).toDouble()) }
                        when {
                            row != null -> currentGeometry.scrollTo(scope, list, currentGeometry.rowTop(row.toInt()), h)
                            cluster?.kind == "approval" -> scope.launch { list.scrollToItem(0) }
                            else -> scrub(last.y)
                        }
                    }
                },
        )
    }
}

private fun DrawScope.drawCluster(cluster: ScrubCluster, palette: Palette, alpha: Float) {
    val lane = size.width / 2
    val x = if (cluster.lane == "r") lane else 0f
    val width = if (cluster.lane == "f") size.width else lane
    val top = Offset(x, cluster.y.toFloat())
    val extent = Size(width, cluster.h.toFloat())
    fun twoTone(tone: String) {
        val color = palette.toneNamed(tone)
        if (extent.height > 2f) drawRect(color.copy(alpha = 0.25f), top + Offset(0f, 2f), Size(width, extent.height - 2f))
        drawRect(color, top, Size(width, minOf(2f, extent.height)))
    }
    when (cluster.kind) {
        "user" -> twoTone("blue")
        "subagent" -> twoTone("green")
        "shell" -> twoTone("magenta")
        "turn" -> twoTone("fg")
        "turnFailed" -> twoTone("red")
        "error" -> drawRect(palette.toneNamed("red"), top, extent)
        "toolFailed" -> drawRect(palette.toneNamed("red").copy(alpha = 0.55f), top, extent)
        "bookmark" -> drawRect(palette.toneNamed("magenta"), top, extent)
        "approval" -> drawRect(palette.toneNamed("yellow").copy(alpha = alpha), top, extent)
        "recap" -> {
            val y = (cluster.y + cluster.h / 2).toFloat()
            drawLine(palette.toneNamed("faint"), Offset(x, y), Offset(x + width, y), 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3f, 3f)))
        }
    }
}

// Beside the rail and clamped into it vertically; laid out where it is measured, so it never needs a second pass.
@Composable
private fun BoxScope.PeekPanel(peek: ScrubPeek, y: Double, railH: Int, palette: Palette, style: TextStyle) {
    val gap = with(LocalDensity.current) { 4.dp.toPx() }
    Column(
        Modifier
            .align(Alignment.TopEnd)
            .padding(end = RAIL_WIDTH + 4.dp)
            .width(260.dp)
            .layout { measurable, constraints ->
                val placeable = measurable.measure(constraints)
                val top = (y - placeable.height / 2.0).coerceAtMost(railH - placeable.height - gap.toDouble()).coerceAtLeast(gap.toDouble())
                layout(placeable.width, placeable.height) { placeable.place(0, top.toInt()) }
            }
            .background(palette.background, RoundedCornerShape(4.dp))
            .border(1.dp, palette.toneNamed("faint").copy(alpha = 0.4f), RoundedCornerShape(4.dp))
            .padding(6.dp),
    ) {
        Text(peek.title, style = style, color = palette.toneNamed("faint"), maxLines = 1, overflow = TextOverflow.Ellipsis)
        for (line in peek.lines) {
            val text = buildAnnotatedString {
                line.glyph?.let { withStyle(SpanStyle(color = palette.toneNamed("dim"))) { append(it) } }
                withStyle(SpanStyle(color = palette.toneNamed(line.tone))) { append(line.text) }
            }
            Text(text, style = style, maxLines = if (line.excerpt) 2 else 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

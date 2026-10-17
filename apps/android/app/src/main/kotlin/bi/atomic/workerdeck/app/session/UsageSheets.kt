package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bi.atomic.workerdeck.app.ui.EngineMark
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.app.ui.WdColors
import bi.atomic.workerdeck.core.ffi.ContextSlice
import bi.atomic.workerdeck.core.ffi.ContextView
import bi.atomic.workerdeck.core.ffi.Mark
import bi.atomic.workerdeck.core.ffi.SessionUsageView
import bi.atomic.workerdeck.core.ffi.Severity
import bi.atomic.workerdeck.core.ffi.UsageWindowView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class Meter { CONTEXT, USAGE }

private fun ringTint(severity: Severity, colors: WdColors): Color = when (severity) {
    Severity.ERROR -> colors.red
    Severity.WARNING -> colors.orange
    Severity.NONE -> colors.secondary
}

private fun barTint(severity: Severity, colors: WdColors): Color = when (severity) {
    Severity.ERROR -> colors.red
    Severity.WARNING -> colors.orange
    Severity.NONE -> colors.accent
}

// The floor keeps a barely touched window visible as a mark rather than as missing.
@Composable
fun RadialGauge(fraction: Double, tint: Color, label: String?, modifier: Modifier = Modifier, diameter: Dp = 20.dp, stroke: Dp = 2.5.dp) {
    val track = Wd.colors.secondary.copy(alpha = 0.25f)
    Box(modifier.size(diameter), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(diameter)) {
            val width = stroke.toPx()
            val inset = width / 2
            val arc = Size(size.width - width, size.height - width)
            drawArc(track, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(width))
            val sweep = 360f * fraction.coerceIn(0.02, 1.0).toFloat()
            drawArc(tint, -90f, sweep, false, Offset(inset, inset), arc, style = Stroke(width, cap = StrokeCap.Round))
        }
        label?.let { Text(it, fontSize = 8.sp, fontWeight = FontWeight.SemiBold, color = Wd.colors.secondary, maxLines = 1) }
    }
}

@Composable
fun UsageHud(usage: SessionUsageView, open: (Meter) -> Unit) {
    val colors = Wd.colors
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        usage.context?.let { context ->
            RadialGauge(
                context.fill,
                ringTint(context.severity, colors),
                context.ringLabel,
                Modifier.clickable { open(Meter.CONTEXT) }.semantics { contentDescription = context.accessibilityLabel },
            )
        }
        val windows = usage.windows.take(3)
        Row(
            Modifier.clickable { open(Meter.USAGE) }.semantics(mergeDescendants = true) { contentDescription = usage.hudLabel.ifEmpty { "Usage" } },
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                windows.isNotEmpty() -> windows.forEach { window ->
                    RadialGauge(window.fill, barTint(window.barSeverity, colors), window.initial, Modifier.alpha(if (window.stale) 0.45f else 1f))
                }
                usage.hudCostText != null -> Text(usage.hudCostText!!, style = MaterialTheme.typography.labelMedium, color = colors.secondary)
                else -> RadialGauge(0.0, colors.secondary, null)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MeterSheet(meter: Meter, usage: SessionUsageView?, refresh: () -> Unit, onDismiss: () -> Unit) {
    val colors = Wd.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { onDismiss() } }
    LaunchedEffect(meter) {
        while (true) {
            delay(60_000)
            refresh()
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = if (colors.dark) colors.raised else colors.background) {
        Column(Modifier.navigationBarsPadding()) {
            SheetHeader(if (meter == Meter.CONTEXT) "Context" else "Usage", close)
            Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
                when (meter) {
                    Meter.CONTEXT -> ContextBody(usage?.context)
                    Meter.USAGE -> usage?.let { UsageBody(it) }
                }
            }
        }
    }
}

@Composable
private fun ContextBody(context: ContextView?) {
    val colors = Wd.colors
    if (context == null) {
        Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("No reading yet", style = MaterialTheme.typography.titleSmall, color = colors.primary)
            Text("The context window is measured after a turn completes.", style = MaterialTheme.typography.bodyMedium, color = colors.secondary)
        }
        return
    }
    SheetSection {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            LabelRow("Used", context.usedText)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Bar(context.fill, barTint(context.barSeverity, colors), Modifier.weight(1f))
                Text(context.percentText, style = MaterialTheme.typography.labelSmall, color = colors.secondary)
            }
        }
    }
    context.model?.let { Footnote(it) }
    if (context.categories.isNotEmpty()) {
        SheetHeading("Breakdown")
        SheetSection {
            context.categories.forEachIndexed { index, slice ->
                if (index > 0) SheetDivider()
                SliceRow(slice)
            }
        }
    }
}

@Composable
private fun SliceRow(slice: ContextSlice) {
    val colors = Wd.colors
    val tint = hexColor(slice.color) ?: colors.accent
    Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(7.dp).background(tint, CircleShape))
            Text(slice.name, style = MaterialTheme.typography.bodyMedium, color = colors.primary, modifier = Modifier.weight(1f))
            Text(slice.tokensText, style = MaterialTheme.typography.bodySmall, color = colors.secondary)
        }
        Bar(slice.fill, tint, Modifier.fillMaxWidth())
    }
}

// The wire color is often a CLI theme token ("inactive"), honoured only when it is a hex color.
private fun hexColor(text: String): Color? {
    val hex = text.removePrefix("#").takeIf { text.startsWith("#") && (it.length == 6 || it.length == 8) } ?: return null
    val value = hex.toLongOrNull(16) ?: return null
    return if (hex.length == 6) Color(0xFF000000 or value) else Color(value)
}

@Composable
private fun UsageBody(usage: SessionUsageView) {
    val colors = Wd.colors
    UsageHeader(usage)
    SheetSection {
        if (usage.windows.isEmpty()) {
            Text(usage.windowsEmptyText, style = MaterialTheme.typography.bodyMedium, color = colors.secondary, modifier = Modifier.padding(16.dp))
        } else {
            usage.windows.forEachIndexed { index, window ->
                if (index > 0) SheetDivider()
                WindowCard(window)
            }
        }
    }
    val cost = usage.cost
    SheetHeading("This session")
    SheetSection {
        LabelRow("Cost", cost.displayText, Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
        if (cost.rows.isNotEmpty()) {
            SheetDivider()
            Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                SmallRow("input", cost.inputText)
                SmallRow("output", cost.outputText)
                SmallRow("cache write", cost.cacheWriteText)
                SmallRow("cache read", cost.cacheReadText)
            }
            SheetDivider()
            Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                cost.rows.forEach { SmallRow(it.model, it.text) }
            }
        }
        listOfNotNull(cost.unpricedText to colors.orange, cost.unknownBasisText to colors.orange, cost.gapText to colors.secondary)
            .filter { it.first != null }
            .forEach { (text, tint) ->
                SheetDivider()
                Text(text!!, style = MaterialTheme.typography.bodySmall, color = tint, modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
            }
    }
    usage.spend?.let { spend ->
        SheetHeading("This profile")
        SheetSection {
            LabelRow("Last 7 days", spend.weekText, Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
            SheetDivider()
            LabelRow("Last 30 days", spend.monthText, Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
            spend.ratioText?.let {
                SheetDivider()
                Text(it, style = MaterialTheme.typography.bodySmall, color = colors.secondary, modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
            }
        }
    }
    Footnote(usage.pricingNote)
}

// The plan capsule only when the engine said: it reports a tier ("max"), never a multiplier.
@Composable
private fun UsageHeader(usage: SessionUsageView) {
    val colors = Wd.colors
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        when (usage.engine) {
            "claude" -> EngineMark(Mark.CLAUDE, tinted = true, size = 20.dp)
            "codex" -> EngineMark(Mark.CODEX, tinted = true, size = 20.dp)
        }
        Text(usage.engineName, style = MaterialTheme.typography.titleSmall, color = colors.primary, modifier = Modifier.weight(1f))
        usage.subscriptionType?.takeIf { it.isNotEmpty() }?.let { plan ->
            Text(
                plan.replaceFirstChar { it.uppercase() },
                style = MaterialTheme.typography.labelLarge,
                color = colors.secondary,
                modifier = Modifier.background(colors.secondary.copy(alpha = 0.16f), CircleShape).padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun WindowCard(window: UsageWindowView) {
    val colors = Wd.colors
    Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(window.longLabel, style = MaterialTheme.typography.bodyLarge, color = colors.primary, modifier = Modifier.weight(1f))
            Text(window.usedText, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = if (window.stale) colors.secondary else colors.primary)
        }
        PaceBar(window.fill, window.pace, barTint(window.barSeverity, colors), Modifier.alpha(if (window.stale) 0.4f else 1f))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            window.resetText?.let {
                Icon(Icons.Filled.Refresh, contentDescription = null, tint = colors.secondary, modifier = Modifier.size(12.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = colors.secondary)
            }
            if (window.overage) Text("overage", style = MaterialTheme.typography.bodySmall, color = colors.orange)
            window.freshText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (window.stale) colors.orange else colors.secondary) }
        }
    }
}

// The pace marker stands taller than the bar so it reads as a scale mark.
@Composable
private fun PaceBar(fraction: Double, pace: Double?, tint: Color, modifier: Modifier = Modifier) {
    val colors = Wd.colors
    BoxWithConstraints(modifier.fillMaxWidth().height(15.dp), contentAlignment = Alignment.CenterStart) {
        val width = maxWidth
        Box(Modifier.fillMaxWidth().height(9.dp).background(colors.secondary.copy(alpha = 0.22f), CircleShape))
        Box(Modifier.width(maxOf(9.dp, width * fraction.coerceIn(0.0, 1.0).toFloat())).height(9.dp).background(tint, CircleShape))
        pace?.let {
            val x = (width * it.coerceIn(0.0, 1.0).toFloat() - 1.5.dp).coerceIn(0.dp, width - 3.dp)
            Box(Modifier.offset(x = x).width(3.dp).height(15.dp).background(colors.primary, CircleShape))
        }
    }
}

@Composable
private fun Bar(fraction: Double, tint: Color, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier.height(4.dp).background(Wd.colors.secondary.copy(alpha = 0.22f), CircleShape)) {
        Box(Modifier.width(maxWidth * fraction.coerceIn(0.0, 1.0).toFloat()).height(4.dp).background(tint, CircleShape))
    }
}

@Composable
internal fun SheetSection(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Wd.colors.secondary.copy(alpha = 0.12f), RoundedCornerShape(18.dp))) { content() }
}

@Composable
internal fun SheetDivider() {
    Spacer(Modifier.padding(start = 16.dp).fillMaxWidth().height(0.5.dp).background(Wd.colors.separator))
}

@Composable
internal fun LabelRow(label: String, value: String, modifier: Modifier = Modifier) {
    val colors = Wd.colors
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = colors.primary, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyLarge, color = colors.secondary)
    }
}

@Composable
private fun SmallRow(label: String, value: String) {
    val colors = Wd.colors
    Row(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = colors.secondary, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall, color = colors.secondary)
    }
}

@Composable
internal fun Footnote(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Wd.colors.secondary, modifier = Modifier.padding(start = 4.dp, end = 4.dp, top = 8.dp))
}

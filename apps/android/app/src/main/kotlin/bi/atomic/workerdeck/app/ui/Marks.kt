package bi.atomic.workerdeck.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bi.atomic.workerdeck.core.ffi.RowState

@Composable
fun EngineMark(engine: String, modifier: Modifier = Modifier, size: Dp = 16.dp) {
    val colors = Wd.colors
    val (glyph, tint) = when (engine) {
        "claude" -> "✻" to colors.coral
        "codex" -> "◎" to colors.primary
        else -> "◆" to colors.secondary
    }
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        Text(glyph, color = tint, fontSize = (size.value * 0.95f).sp, lineHeight = size.value.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun StateGlyph(state: RowState, modifier: Modifier = Modifier, size: Dp = 14.dp) {
    val colors = Wd.colors
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        when (state) {
            RowState.WORKING -> CircularProgressIndicator(Modifier.size(size - 2.dp), color = colors.blue, strokeWidth = 1.5.dp)
            RowState.ATTENTION -> Icon(Icons.Filled.Notifications, contentDescription = "Needs you", tint = colors.orange, modifier = Modifier.size(size))
            RowState.IDLE -> Box(Modifier.size(7.dp).background(colors.green, CircleShape))
            RowState.ENDED -> Box(Modifier.size(7.dp).background(colors.tertiary, CircleShape))
        }
    }
}

@Composable
fun CountBadge(count: UInt, color: Color = Wd.colors.blue) {
    Box(
        Modifier.widthIn(min = 22.dp).background(color, RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(count.toString(), color = Color.White, fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

fun statusTint(status: String, colors: WdColors): Color = when (status) {
    "starting", "running" -> colors.blue
    "awaiting_approval" -> colors.orange
    "idle" -> colors.green
    "parked" -> colors.purple
    "failed" -> colors.red
    else -> colors.secondary
}

fun modeTint(mode: String?, colors: WdColors): Color = when (mode) {
    "plan" -> colors.blue
    "acceptEdits", "dontAsk" -> colors.orange
    "bypassPermissions" -> colors.red
    else -> colors.secondary
}

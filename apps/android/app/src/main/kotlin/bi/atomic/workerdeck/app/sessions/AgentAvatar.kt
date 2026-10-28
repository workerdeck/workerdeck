package bi.atomic.workerdeck.app.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.ui.BadgeGlyph
import bi.atomic.workerdeck.app.ui.EngineMark
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.TrayMember

// The no-avatar fallback: a native client draws no face until it has a face renderer.
@Composable
fun AgentAvatar(row: ListRow, size: Dp) {
    val colors = Wd.colors
    val corner = if (size >= 28.dp) 14.dp else 11.dp
    Box(Modifier.size(size)) {
        Box(
            Modifier.size(size).drawBehind {
                val dash = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.dp.toPx()))
                val stroke = 1.dp.toPx()
                drawRoundRect(
                    colors.tertiary,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = Size(this.size.width - stroke, this.size.height - stroke),
                    cornerRadius = CornerRadius(4.dp.toPx()),
                    style = Stroke(stroke, pathEffect = dash),
                )
            },
            contentAlignment = Alignment.Center,
        ) { EngineMark(row.mark, row.markTinted, size = size / 2) }
        row.badge?.let { badge ->
            Box(
                Modifier.align(Alignment.BottomEnd).offset(4.dp, 4.dp).size(corner).background(colors.background, CircleShape),
                contentAlignment = Alignment.Center,
            ) { BadgeGlyph(badge, size = corner * 0.72f) }
        }
    }
}

// A tray picture: idle by definition (Auto shows every busy Member as a row), so no badge.
@Composable
fun TrayAvatar(member: TrayMember, size: Dp) {
    Box(Modifier.size(size).alpha(if (member.asleep) 0.6f else 1f).background(Wd.colors.raised, RoundedCornerShape(4.dp)))
}

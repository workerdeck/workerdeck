package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.sessions.Face
import bi.atomic.workerdeck.app.sessions.ReasonChips
import bi.atomic.workerdeck.app.sessions.rememberListTones
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.FleetMember

class LeadFleet(val members: List<FleetMember>, val open: (FleetMember) -> Unit, val refresh: () -> Unit)

@Composable
fun FleetStrip(fleet: LeadFleet, onRetry: (FleetMember, Long) -> Unit) {
    if (fleet.members.isEmpty()) return
    Column(Modifier.testTag("fleet-strip").fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (member in fleet.members) FleetRow(member, open = { fleet.open(member) }, onRetry = onRetry)
        }
        HorizontalDivider(color = Wd.colors.tertiary.copy(alpha = 0.3f))
    }
}

@Composable
private fun FleetRow(member: FleetMember, open: () -> Unit, onRetry: (FleetMember, Long) -> Unit) {
    val colors = Wd.colors
    val small = MaterialTheme.typography.bodySmall
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier.weight(1f).clip(RoundedCornerShape(4.dp)).clickable(onClick = open).semantics { contentDescription = "Open ${member.name}" },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            FleetFace(member)
            Text(member.name, style = small, color = colors.primary, maxLines = 1)
            ReasonChips(member.reasons, rememberListTones())
            Text(member.text, style = small, color = colors.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        member.retry?.let { n ->
            OutlinedButton(onClick = { onRetry(member, n.toLong()) }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.height(28.dp)) {
                Text("Retry start", style = small, color = colors.accent)
            }
        }
    }
}

@Composable
private fun FleetFace(member: FleetMember) {
    member.face?.let {
        Face(it, 16.dp)
        return
    }
    val tint = Wd.colors.tertiary
    Box(
        Modifier.size(16.dp).drawBehind {
            val stroke = 1.dp.toPx()
            drawRoundRect(
                tint,
                topLeft = Offset(stroke / 2, stroke / 2),
                size = Size(size.width - stroke, size.height - stroke),
                cornerRadius = CornerRadius(4.dp.toPx()),
                style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.dp.toPx()))),
            )
        },
    )
}

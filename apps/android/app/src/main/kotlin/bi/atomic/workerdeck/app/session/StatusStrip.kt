package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.app.ui.modeTint
import bi.atomic.workerdeck.app.ui.statusTint
import bi.atomic.workerdeck.core.ffi.ConnectionState
import bi.atomic.workerdeck.core.ffi.SessionChrome
import bi.atomic.workerdeck.core.ffi.SessionUsageView

// The terminal theme's status line: a flat band under a hairline. Connection trouble takes the status slot, since a
// session status over a dead socket is a stale reading shown as a live one.
@Composable
fun StatusStrip(
    chrome: SessionChrome?,
    connection: ConnectionState,
    usage: SessionUsageView?,
    onReconnect: () -> Unit,
    onPicker: (Picker) -> Unit,
    onMeter: (Meter) -> Unit,
) {
    val colors = Wd.colors
    Column(Modifier.fillMaxWidth().background(colors.background)) {
        Box(Modifier.fillMaxWidth().height(0.5.dp).background(colors.separator))
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (connection == ConnectionState.LIVE) {
                    val status = chrome?.status.orEmpty()
                    val label = chrome?.statusLabel?.takeIf { it.isNotEmpty() } ?: "Connected"
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(7.dp).background(statusTint(status, colors), CircleShape))
                        Text(label, style = MaterialTheme.typography.labelMedium, color = colors.secondary)
                        if (chrome?.busy == true) CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.5.dp, color = colors.secondary)
                    }
                } else {
                    val (label, tint) = when (connection) {
                        ConnectionState.CONNECTING -> "Connecting" to colors.secondary
                        ConnectionState.RECONNECTING -> "Reconnecting" to colors.orange
                        ConnectionState.OFFLINE -> "Offline · tap to retry" to colors.red
                        ConnectionState.UNREACHABLE -> "Unreachable · tap to retry" to colors.red
                        ConnectionState.LIVE -> "" to colors.secondary
                    }
                    Text(
                        label,
                        style = MaterialTheme.typography.labelMedium,
                        color = tint,
                        modifier = Modifier.clickable(onClick = onReconnect),
                    )
                }
                val model = chrome?.modelLabel
                Chip(model ?: "Model", if (model == null) colors.secondary else colors.primary, Modifier.weight(1f, fill = false)) { onPicker(Picker.MODEL) }
                Chip(chrome?.modeLabel ?: "Mode", modeTint(chrome?.permissionMode, colors)) { onPicker(Picker.MODE) }
            }
            usage?.let { UsageHud(it, onMeter) }
        }
    }
}

@Composable
private fun Chip(text: String, tint: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Row(modifier.clickable(onClick = onClick).padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = Wd.colors.tertiary, modifier = Modifier.size(12.dp))
    }
}

package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ConversationNotice
import bi.atomic.workerdeck.core.ffi.ArchivedView

// The conversation lines above a transcript: a past conversation's banner, a first message whose delivery is unknown,
// and a new conversation that did not start.
@Composable
fun ConversationBars(
    archived: ArchivedView?,
    notice: ConversationNotice?,
    onGoToCurrent: (() -> Unit)?,
    onSettle: (Boolean) -> Unit,
    onRetryStart: () -> Unit,
) {
    val colors = Wd.colors
    val small = MaterialTheme.typography.bodySmall
    archived?.let { view ->
        Bar("archived-banner") {
            Text("↺", style = small, color = colors.secondary)
            Column(Modifier.weight(1f)) {
                Text(view.banner, style = small, color = colors.secondary)
                view.note?.let { Text(it, style = small, color = colors.tertiary) }
            }
            if (view.current != null && onGoToCurrent != null) BarButton("Go to current", onGoToCurrent)
        }
    }
    notice?.uncertainPrompt?.let { text ->
        Bar("undelivered-bar") {
            Column(Modifier.weight(1f)) {
                Text("The first message may not have been delivered", style = small, color = colors.secondary)
                Text(text, style = small, color = colors.tertiary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            BarButton("Send again") { onSettle(true) }
            TextButton(onClick = { onSettle(false) }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.height(36.dp)) {
                Text("Dismiss", style = small, color = colors.secondary)
            }
        }
    }
    notice?.startFailed?.let { reason ->
        Bar("retry-start-bar") {
            Column(Modifier.weight(1f)) {
                Text("The new conversation did not start", style = small, color = colors.secondary)
                Text(reason, style = small, color = colors.tertiary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            BarButton("Retry start", onRetryStart)
        }
    }
}

@Composable
private fun Bar(tag: String, content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier
            .testTag(tag)
            .padding(start = 8.dp, end = 8.dp, top = 6.dp)
            .fillMaxWidth()
            .background(Wd.colors.secondary.copy(alpha = 0.10f), RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

@Composable
private fun BarButton(label: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 10.dp), modifier = Modifier.height(32.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = Wd.colors.accent)
    }
}

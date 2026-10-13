package bi.atomic.workerdeck.app.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.RowState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(model: SessionsModel, gatewayName: String, onOpen: (ListRow) -> Unit, onForget: () -> Unit) {
    val ui by model.ui.collectAsStateWithLifecycle()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sessions") },
                actions = { TextButton(onClick = onForget) { Text(gatewayName) } },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when {
                !ui.loaded -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                ui.groups.isEmpty() && ui.error == null -> Text("No sessions", Modifier.align(Alignment.Center))
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    ui.error?.let { error ->
                        item(key = "error") {
                            Text(
                                error,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.padding(16.dp),
                            )
                        }
                    }
                    for (group in ui.groups) {
                        group.label?.let { label ->
                            item(key = "group:${group.key}") {
                                GroupHeader(label, group.sessions, group.unseen, group.collapsed) { model.toggleGroup(group.key) }
                            }
                        }
                        if (!group.collapsed) {
                            items(group.rows, key = { "${group.key}/${it.key}" }) { row ->
                                SessionRowView(row, onOpen = { onOpen(row) }, onToggleTeam = { model.toggleTeam(row.hostId, row.sessionId) })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GroupHeader(label: String, count: UInt, unseen: UInt, collapsed: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(if (collapsed) "▸" else "▾", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        if (unseen > 0u) Badge { Text(unseen.toString()) }
        Spacer(Modifier.width(8.dp))
        Text(count.toString(), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

fun stateColor(state: RowState): Color = when (state) {
    RowState.ATTENTION -> Color(0xFFD7BA7D)
    RowState.WORKING -> Color(0xFF4EC9A0)
    RowState.IDLE -> Color(0xFF8A8A8A)
    RowState.ENDED -> Color(0xFF5A5A5A)
}

@Composable
private fun SessionRowView(row: ListRow, onOpen: () -> Unit, onToggleTeam: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(start = 16.dp + 20.dp * row.depth.toInt(), end = 16.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(10.dp).background(stateColor(row.state), CircleShape))
        Column(Modifier.weight(1f)) {
            Text(row.title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val detail = listOfNotNull(row.project, row.status ?: row.stateLabel).joinToString(" · ")
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (row.members > 0u) {
            TextButton(onClick = onToggleTeam) { Text("${if (row.teamCollapsed) "+" else "−"}${row.members}") }
        }
        if (row.unseen > 0u) Badge { Text(row.unseen.toString()) }
    }
}

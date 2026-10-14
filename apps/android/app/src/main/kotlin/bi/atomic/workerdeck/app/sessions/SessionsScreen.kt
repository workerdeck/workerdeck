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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.ui.CountBadge
import bi.atomic.workerdeck.app.ui.EngineMark
import bi.atomic.workerdeck.app.ui.StateGlyph
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.RowState
import bi.atomic.workerdeck.core.ffi.ago

private val GUTTER = 16.dp
private val MARK_COLUMN = 22.dp
private val CARD_AVATAR = 48.dp
private val MEMBER_AVATAR = 32.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(model: SessionsModel, gatewayName: String, onOpen: (ListRow) -> Unit, onForget: () -> Unit) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val colors = Wd.colors
    Scaffold(
        containerColor = colors.background,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Sessions", style = MaterialTheme.typography.titleMedium) },
                actions = { GatewayMenu(gatewayName, onForget) },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = colors.background),
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = ui.refreshing,
            onRefresh = model::pullRefresh,
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            when {
                !ui.loaded -> CircularProgressIndicator(Modifier.align(Alignment.Center).size(28.dp), strokeWidth = 2.dp)
                ui.groups.isEmpty() && ui.error == null -> LazyColumn(Modifier.fillMaxSize()) {
                    item(key = "empty") { EmptyList() }
                }
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    ui.error?.let { error ->
                        item(key = "error") { ErrorStrip(error) }
                    }
                    val now = System.currentTimeMillis().toDouble()
                    for (group in ui.groups) {
                        group.label?.let { label ->
                            item(key = "group:${group.key}") {
                                GroupHeader(label, group.sessions, group.unseen, group.collapsed) { model.toggleGroup(group.key) }
                            }
                        }
                        if (!group.collapsed) {
                            items(group.rows, key = { "${group.key}/${it.key}" }) { row ->
                                SessionRow(row, now, row.avatarKey?.let { ui.avatars[it] }, onOpen = { onOpen(row) }, onToggleTeam = { model.toggleTeam(row.hostId, row.sessionId) })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GatewayMenu(gatewayName: String, onForget: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "Gateway") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(gatewayName, color = Wd.colors.secondary) },
                onClick = {},
                enabled = false,
            )
            DropdownMenuItem(
                text = { Text("Forget this gateway", color = Wd.colors.red) },
                onClick = {
                    open = false
                    onForget()
                },
            )
        }
    }
}

@Composable
private fun LazyItemScope.EmptyList() {
    Column(
        Modifier.fillParentMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("No sessions", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text("Sessions on this gateway show up here.", color = Wd.colors.secondary, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ErrorStrip(error: String) {
    Text(
        error,
        color = Wd.colors.red,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.fillMaxWidth().padding(horizontal = GUTTER, vertical = 8.dp),
    )
}

@Composable
private fun GroupHeader(label: String, count: UInt, unseen: UInt, collapsed: Boolean, onToggle: () -> Unit) {
    val colors = Wd.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(start = GUTTER, end = GUTTER, top = 18.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label.uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = colors.secondary,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (unseen > 0u) {
            CountBadge(unseen)
            Spacer(Modifier.width(8.dp))
        }
        Text(count.toString(), style = MaterialTheme.typography.labelMedium, color = colors.tertiary)
        Icon(
            if (collapsed) Icons.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown,
            contentDescription = if (collapsed) "Expand" else "Collapse",
            tint = colors.tertiary,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun SessionRow(row: ListRow, now: Double, avatar: AvatarFrames?, onOpen: () -> Unit, onToggleTeam: () -> Unit) {
    val colors = Wd.colors
    val indent = 20.dp * row.depth.toInt()
    val agent = row.agentId != null
    val column = if (!agent) MARK_COLUMN else if (row.depth > 0u) MEMBER_AVATAR else CARD_AVATAR
    Column(Modifier.fillMaxWidth().clickable(onClick = onOpen).alpha(if (agent && row.asleep) 0.6f else 1f)) {
        Row(
            Modifier.fillMaxWidth().padding(start = GUTTER + indent, end = GUTTER, top = 12.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (agent) {
                AgentAvatar(row, avatar, column)
            } else {
                Column(Modifier.width(MARK_COLUMN).padding(top = 3.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    StateGlyph(row.state)
                    Spacer(Modifier.height(8.dp))
                    EngineMark(row.mark, row.markTinted)
                }
            }
            Column(Modifier.weight(1f)) {
                Text(
                    row.title,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (row.state == RowState.ENDED) colors.secondary else colors.primary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    details(row, now),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                row.status?.let { status ->
                    Spacer(Modifier.height(2.dp))
                    Text(status, style = MaterialTheme.typography.bodySmall, color = colors.green, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                if (row.members > 0u) {
                    Text(
                        "${row.members} ${if (row.teamCollapsed) "▸" else "▾"}",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.secondary,
                        modifier = Modifier
                            .background(colors.raised, RoundedCornerShape(50))
                            .clickable(onClick = onToggleTeam)
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                }
                if (row.unseen > 0u) {
                    CountBadge(row.unseen, if (row.state == RowState.ENDED) colors.badge else colors.blue)
                }
            }
        }
        HorizontalDivider(Modifier.padding(start = GUTTER + indent + column + 10.dp), thickness = 0.5.dp, color = colors.separator)
    }
}

@Composable
private fun details(row: ListRow, now: Double) = buildAnnotatedString {
    val colors = Wd.colors
    val parts = mutableListOf<Pair<String, Color>>()
    row.modelLabel?.let { parts += it to if (row.nameTinted) colors.coral else colors.secondary }
    if (row.project.isNotEmpty()) parts += row.project to colors.secondary
    if (row.hostName.isNotEmpty()) parts += row.hostName to colors.secondary
    if (row.lastActivityAt > 0) parts += ago(row.lastActivityAt, now) to colors.secondary
    parts.forEachIndexed { index, (text, color) ->
        if (index > 0) append(" · ")
        withStyle(SpanStyle(color = color)) { append(text) }
    }
}

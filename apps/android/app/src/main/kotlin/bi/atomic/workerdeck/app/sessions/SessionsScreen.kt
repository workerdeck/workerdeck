package bi.atomic.workerdeck.app.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.gateway.Gateway
import bi.atomic.workerdeck.app.ui.CountBadge
import bi.atomic.workerdeck.app.ui.EngineMark
import bi.atomic.workerdeck.app.ui.StateGlyph
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.TrayMember
import bi.atomic.workerdeck.core.ffi.RowState
import bi.atomic.workerdeck.core.ffi.ago
import kotlinx.coroutines.launch

private val GUTTER = 16.dp
private val MARK_COLUMN = 22.dp
private val CARD_AVATAR = 48.dp
private val MEMBER_AVATAR = 32.dp
private val TRAY_AVATAR = 22.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(model: SessionsModel, gateways: List<Gateway>, onOpen: (hostId: String, sessionId: String, title: String) -> Unit, onAdd: () -> Unit, onForget: (Gateway) -> Unit) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val colors = Wd.colors
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    LaunchedEffect(ui.notice) {
        ui.notice?.let {
            scope.launch { snackbar.showSnackbar(it) }
            model.noticeShown()
        }
    }
    Scaffold(
        containerColor = colors.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Sessions", style = MaterialTheme.typography.titleMedium) },
                actions = { GatewayMenu(gateways, onAdd, onForget) },
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
                                SessionRow(
                                    row,
                                    now,
                                    ui.avatars,
                                    onOpen = { onOpen(row.hostId, row.sessionId, row.title) },
                                    onOpenMember = { onOpen(it.hostId, it.sessionId, it.title) },
                                    onToggleTeam = { model.toggleTeam(row.hostId, row.sessionId) },
                                    onSleep = { model.sleep(row.hostId, row.sessionId) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

// Each paired gateway with its own Forget, then Add. Forgetting asks first: the key is gone once confirmed.
@Composable
private fun GatewayMenu(gateways: List<Gateway>, onAdd: () -> Unit, onForget: (Gateway) -> Unit) {
    var open by remember { mutableStateOf(false) }
    var forgetting by remember { mutableStateOf<Gateway?>(null) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "Gateways") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (gateway in gateways) {
                DropdownMenuItem(
                    text = { Text(gateway.name, color = Wd.colors.secondary) },
                    onClick = {},
                    enabled = false,
                )
                DropdownMenuItem(
                    text = { Text("Forget ${gateway.name}", color = Wd.colors.red) },
                    onClick = {
                        open = false
                        forgetting = gateway
                    },
                )
                HorizontalDivider()
            }
            DropdownMenuItem(
                text = { Text("Add a gateway") },
                onClick = {
                    open = false
                    onAdd()
                },
            )
        }
    }
    forgetting?.let { gateway ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text("Forget ${gateway.name}?") },
            text = { Text("The address and auth key are removed from this device. The gateway keeps running.") },
            confirmButton = {
                TextButton(onClick = {
                    forgetting = null
                    onForget(gateway)
                }) { Text("Forget", color = Wd.colors.red) }
            },
            dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Cancel") } },
        )
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    row: ListRow,
    now: Double,
    avatars: Map<String, AvatarFrames>,
    onOpen: () -> Unit,
    onOpenMember: (TrayMember) -> Unit,
    onToggleTeam: () -> Unit,
    onSleep: () -> Unit,
) {
    val colors = Wd.colors
    var menu by remember { mutableStateOf(false) }
    val avatar = row.avatarKey?.let { avatars[it] }
    val indent = 20.dp * row.depth.toInt()
    val agent = row.agentId != null
    val column = if (!agent) MARK_COLUMN else if (row.depth > 0u) MEMBER_AVATAR else CARD_AVATAR
    Box {
        Column(
            Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onOpen, onLongClick = if (row.canSleep) ({ menu = true }) else null)
                .alpha(if (!row.asleep) 1f else if (agent) 0.6f else 0.55f),
        ) {
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
                        TeamTray(row, avatars, onOpenMember, onToggleTeam)
                        Spacer(Modifier.width(8.dp))
                    }
                    if (row.unseen > 0u) {
                        CountBadge(row.unseen, if (row.state == RowState.ENDED) colors.badge else colors.blue)
                    }
                }
            }
            HorizontalDivider(Modifier.padding(start = GUTTER + indent + column + 10.dp), thickness = 0.5.dp, color = colors.separator)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, offset = DpOffset(GUTTER + indent, 0.dp)) {
            DropdownMenuItem(
                text = { Text("Sleep") },
                onClick = {
                    menu = false
                    onSleep()
                },
            )
        }
    }
}

// Auto's tray: the idle Members as pictures (a tap opens one), then `+n` past three, else a chevron that expands the
// team or, expanded, returns it to Auto.
@Composable
private fun TeamTray(row: ListRow, avatars: Map<String, AvatarFrames>, onOpenMember: (TrayMember) -> Unit, onToggle: () -> Unit) {
    val colors = Wd.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        for (member in row.tray) {
            Box(Modifier.clip(RoundedCornerShape(4.dp)).clickable { onOpenMember(member) }.semantics { contentDescription = "Open ${member.title}" }) {
                TrayAvatar(member, member.avatarKey?.let { avatars[it] }, TRAY_AVATAR)
            }
        }
        Box(
            Modifier
                .clip(RoundedCornerShape(50))
                .background(colors.raised)
                .clickable(onClick = onToggle)
                .semantics { contentDescription = if (row.teamExpanded) "Show only active Members" else "Show all Team Members" }
                .padding(horizontal = 8.dp, vertical = 3.dp),
        ) {
            if (row.trayOverflow > 0u && !row.teamExpanded) {
                Text("+${row.trayOverflow}", style = MaterialTheme.typography.labelMedium, color = colors.secondary)
            } else {
                Icon(
                    if (row.teamExpanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = colors.secondary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

@Composable
private fun details(row: ListRow, now: Double) = buildAnnotatedString {
    val colors = Wd.colors
    val parts = mutableListOf<Pair<String, Color>>()
    row.modelLabel?.let { parts += it to if (row.nameTinted) colors.coral else colors.secondary }
    if (row.project.isNotEmpty()) parts += row.project to colors.secondary
    if (row.showGateway && row.hostName.isNotEmpty()) parts += row.hostName to colors.secondary
    if (row.lastActivityAt > 0) parts += ago(row.lastActivityAt, now) to colors.secondary
    parts.forEachIndexed { index, (text, color) ->
        if (index > 0) append(" · ")
        withStyle(SpanStyle(color = color)) { append(text) }
    }
}

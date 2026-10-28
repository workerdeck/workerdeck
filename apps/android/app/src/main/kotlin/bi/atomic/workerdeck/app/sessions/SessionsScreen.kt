package bi.atomic.workerdeck.app.sessions

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.Check
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import bi.atomic.workerdeck.R
import bi.atomic.workerdeck.app.session.Entry
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.core.ffi.ListStep
import bi.atomic.workerdeck.core.ffi.StepKind
import bi.atomic.workerdeck.core.ffi.StepState
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.ui.platform.testTag
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
import androidx.compose.material.icons.filled.Add
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
import bi.atomic.workerdeck.app.ui.BadgeGlyph
import bi.atomic.workerdeck.app.ui.CountBadge
import bi.atomic.workerdeck.app.ui.EngineMark
import bi.atomic.workerdeck.app.ui.StateGlyph
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.TrayMember
import bi.atomic.workerdeck.core.ffi.RowState
import bi.atomic.workerdeck.core.ffi.ago
import bi.atomic.workerdeck.core.ffi.deleteAgentMessage
import bi.atomic.workerdeck.core.ffi.deleteAgentTitle
import bi.atomic.workerdeck.core.ffi.newConversationHint
import kotlinx.coroutines.launch

private val GUTTER = 16.dp
private val MARK_COLUMN = 22.dp
private val CARD_AVATAR = 48.dp
private val MEMBER_AVATAR = 32.dp
private val TRAY_AVATAR = 22.dp
private val MEMBER_INDENT = 24.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    model: SessionsModel,
    gateways: List<Gateway>,
    onOpen: (hostId: String, sessionId: String, title: String, entry: Entry?) -> Unit,
    onOpenPast: (hostId: String, sessionId: String, title: String, conversation: Long) -> Unit,
    onAdd: () -> Unit,
    onForget: (Gateway) -> Unit,
    onNew: (hostId: String, agent: Boolean) -> Unit,
) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val colors = Wd.colors
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var deleting by remember { mutableStateOf<ListRow?>(null) }
    var history by remember { mutableStateOf<ConversationsTarget?>(null) }
    val discard by model.discard.collectAsStateWithLifecycle()
    var pastOpen by remember { mutableStateOf(false) }
    LaunchedEffect(ui.notice) {
        ui.notice?.let {
            scope.launch { snackbar.showSnackbar(it) }
            model.noticeShown()
        }
    }
    BackHandler(enabled = ui.search.isNotEmpty()) { model.setSearch("") }
    Scaffold(
        containerColor = colors.background,
        snackbarHost = { SnackbarHost(snackbar) },
        contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Top),
        bottomBar = {
            SearchBar(ui.search, model::setSearch) { NewMenu(gateways, model::canCreateAgent, onNew) }
        },
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Sessions", style = MaterialTheme.typography.titleMedium) },
                actions = {
                    GatewayMenu(gateways, onAdd, onForget, onPastAgents = if (ui.pastAgents.isNotEmpty()) ({ pastOpen = true }) else null)
                },
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
                    item(key = "empty") { EmptyList(searching(ui.search)) }
                }
                else -> LazyColumn(Modifier.fillMaxSize().testTag("sessions")) {
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
                                    onOpen = { onOpen(row.hostId, row.sessionId, row.title, it) },
                                    onOpenMember = { onOpen(it.hostId, it.sessionId, it.title, null) },
                                    onStopStep = { model.stopStep(row.hostId, row.sessionId, row.conversation, it) },
                                    onToggleTeam = { model.toggleTeam(row.hostId, row.sessionId) },
                                    onSleep = { model.sleep(row.hostId, row.sessionId, row.conversation) },
                                    onNewConversation = { model.newConversation(row) },
                                    onConversations = {
                                        history = ConversationsTarget(row.hostId, row.sessionId, row.agent ?: row.title, row.title, retired = false)
                                    },
                                    onDelete = { deleting = row },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    deleting?.let { row ->
        val name = row.agent
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(deleteAgentTitle(name ?: "this agent")) },
            text = { Text(deleteAgentMessage(name ?: "This agent")) },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    model.deleteAgent(row)
                }) { Text("Delete agent", color = Wd.colors.red) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
    discard?.let { pending ->
        AlertDialog(
            onDismissRequest = model::discardDismissed,
            title = { Text(pending.confirmation.title) },
            text = { Text(pending.confirmation.detail) },
            confirmButton = {
                TextButton(onClick = { model.discardAndCut(pending) }) { Text(pending.confirmation.confirm, color = Wd.colors.red) }
            },
            dismissButton = { TextButton(onClick = model::discardDismissed) { Text("Cancel") } },
        )
    }
    if (pastOpen) {
        PastAgentsSheet(
            ui.pastAgents,
            showGateway = { id -> gateways.takeIf { it.size > 1 }?.firstOrNull { it.id == id }?.name },
            onPick = { entry ->
                pastOpen = false
                history = ConversationsTarget(entry.hostId, entry.agent.id, entry.agent.name, null, retired = true)
            },
            onDismiss = { pastOpen = false },
        )
    }
    history?.let { target ->
        ConversationsSheet(
            target,
            load = { model.conversations(target.hostId, target.sessionId, target.title) },
            onOpen = { title ->
                history = null
                onOpen(target.hostId, target.sessionId, title, null)
            },
            onOpenPast = { n, title ->
                history = null
                onOpenPast(target.hostId, target.sessionId, title, n)
            },
            onDismiss = { history = null },
        )
    }
}

// New session, and New agent where the gateway runs agents; with more than one gateway the menu names them. One
// gateway without agents skips the menu.
@Composable
private fun NewMenu(gateways: List<Gateway>, canCreateAgent: (String) -> Boolean, onNew: (String, Boolean) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = {
            val only = gateways.singleOrNull()
            if (only != null && !canCreateAgent(only.id)) onNew(only.id, false) else open = true
        }) { Icon(Icons.Filled.Add, contentDescription = "New") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (gateway in gateways) {
                if (gateways.size > 1) {
                    DropdownMenuItem(text = { Text(gateway.name, color = Wd.colors.secondary) }, onClick = {}, enabled = false)
                }
                DropdownMenuItem(text = { Text("New session") }, onClick = {
                    open = false
                    onNew(gateway.id, false)
                })
                if (canCreateAgent(gateway.id)) {
                    DropdownMenuItem(text = { Text("New agent") }, onClick = {
                        open = false
                        onNew(gateway.id, true)
                    })
                }
            }
        }
    }
}

// Each paired gateway with its own Forget, then Add. Forgetting asks first: the key is gone once confirmed.
@Composable
private fun GatewayMenu(gateways: List<Gateway>, onAdd: () -> Unit, onForget: (Gateway) -> Unit, onPastAgents: (() -> Unit)?) {
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
            onPastAgents?.let { show ->
                DropdownMenuItem(
                    text = { Text("Past agents") },
                    onClick = {
                        open = false
                        show()
                    },
                )
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

// The bottom bar: search on the left, New on the right, above the keyboard when it is up.
@Composable
private fun SearchBar(text: String, onChange: (String) -> Unit, trailing: @Composable () -> Unit) {
    val colors = Wd.colors
    val focus = LocalFocusManager.current
    Row(
        Modifier.fillMaxWidth().background(colors.background).navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(22.dp)).background(colors.secondary.copy(alpha = 0.14f)).padding(start = 14.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Search, contentDescription = null, tint = colors.secondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f)) {
                if (text.isEmpty()) {
                    Text("Search sessions", color = colors.secondary, style = MaterialTheme.typography.bodyMedium)
                }
                BasicTextField(
                    value = text,
                    onValueChange = onChange,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onBackground),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.onBackground),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
                    modifier = Modifier.fillMaxWidth().testTag("search"),
                )
            }
            if (text.isNotEmpty()) {
                IconButton(onClick = { onChange("") }, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Close, contentDescription = "Clear search", tint = colors.secondary, modifier = Modifier.size(18.dp))
                }
            }
        }
        Spacer(Modifier.width(4.dp))
        trailing()
    }
}

@Composable
private fun LazyItemScope.EmptyList(searching: Boolean) {
    Column(
        Modifier.fillParentMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(if (searching) "No matches" else "No sessions", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            if (searching) "No session matches the current search." else "Sessions on this gateway show up here.", color = Wd.colors.secondary, style = MaterialTheme.typography.bodyMedium)
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
    onOpen: (Entry?) -> Unit,
    onOpenMember: (TrayMember) -> Unit,
    onStopStep: (ListStep) -> Unit,
    onToggleTeam: () -> Unit,
    onSleep: () -> Unit,
    onNewConversation: () -> Unit,
    onConversations: () -> Unit,
    onDelete: () -> Unit,
) {
    val colors = Wd.colors
    var menu by remember { mutableStateOf(false) }
    val agent = row.agentId != null
    val member = agent && row.depth > 0u
    val indent = (if (member) MEMBER_INDENT else 20.dp) * row.depth.toInt()
    val column = if (!agent) MARK_COLUMN else if (member) MEMBER_AVATAR else CARD_AVATAR
    Box {
        Column(
            Modifier
                .fillMaxWidth()
                .testTag("session-row")
                .combinedClickable(onClick = { onOpen(null) }, onLongClick = { menu = true })
                .alpha(if (!row.asleep) 1f else if (agent) 0.6f else 0.55f),
        ) {
            if (member) {
                MemberLine(row, now, Modifier.padding(start = GUTTER + indent, end = GUTTER, top = 6.dp, bottom = 6.dp))
            } else Row(
                Modifier.fillMaxWidth().padding(start = GUTTER + indent, end = GUTTER, top = 12.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (agent) {
                    AgentAvatar(row, column)
                } else {
                    Column(Modifier.width(MARK_COLUMN).padding(top = 3.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        row.badge?.let { BadgeGlyph(it, size = 14.dp) } ?: StateGlyph(row.state)
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
                        TeamTray(row, onOpenMember, onToggleTeam)
                        Spacer(Modifier.width(8.dp))
                    }
                    if (row.unseen > 0u) {
                        CountBadge(row.unseen, if (row.state == RowState.ENDED) colors.badge else colors.blue)
                    }
                }
            }
            for (step in row.steps) {
                StepLine(step, Modifier.padding(start = GUTTER + indent + column + 10.dp, end = GUTTER - 8.dp), onOpen = { onOpen(stepEntry(step)) }, onStop = { onStopStep(step) })
            }
            HorizontalDivider(Modifier.padding(start = GUTTER + indent + column + 10.dp), thickness = 0.5.dp, color = colors.separator)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, offset = DpOffset(GUTTER + indent, 0.dp)) {
            if (row.canNewConversation) {
                DropdownMenuItem(
                    text = {
                        Column {
                            Text("New conversation")
                            Text(row.newConversationBlocked ?: newConversationHint(), style = MaterialTheme.typography.bodySmall, color = colors.secondary)
                        }
                    },
                    enabled = row.newConversationBlocked == null,
                    onClick = {
                        menu = false
                        onNewConversation()
                    },
                )
            }
            DropdownMenuItem(
                text = { Text("Conversations…") },
                onClick = {
                    menu = false
                    onConversations()
                },
            )
            if (row.canSleep) {
                DropdownMenuItem(
                    text = { Text("Sleep") },
                    onClick = {
                        menu = false
                        onSleep()
                    },
                )
            }
            if (agent) {
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Delete agent…", color = colors.red) },
                    onClick = {
                        menu = false
                        onDelete()
                    },
                )
            }
        }
    }
}

// An agent opens its takeover, a task its call's row (a checklist item, with no call, just the session), a shell its screen.
private fun stepEntry(step: ListStep): Entry? = when (step.kind) {
    StepKind.AGENT -> Entry.Subagent(step.key)
    StepKind.TASK -> step.toolUseId?.let(Entry::Reveal)
    StepKind.SHELL -> Entry.Shell(step.key)
}

// One line per step under its card, the iOS step row: the state's mark, the label, the reading, and stop when it can.
@Composable
private fun StepLine(step: ListStep, modifier: Modifier, onOpen: () -> Unit, onStop: () -> Unit) {
    val colors = Wd.colors
    val palette = remember(colors.dark) { Palette.of(colors.dark) }
    val tone = when {
        step.state == StepState.FAILED -> palette.toneNamed("red")
        step.kind == StepKind.SHELL -> palette.toneNamed("magenta")
        step.kind == StepKind.AGENT -> palette.toneNamed("green")
        step.state == StepState.PENDING -> colors.tertiary
        else -> colors.secondary
    }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).then(modifier).height(32.dp).semantics { contentDescription = step.title },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.width(16.dp), contentAlignment = Alignment.Center) {
            when {
                step.kind == StepKind.SHELL -> Text("$", color = tone, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                step.state == StepState.RUNNING -> CircularProgressIndicator(Modifier.size(11.dp), color = tone, strokeWidth = 1.5.dp)
                step.state == StepState.FAILED -> Icon(painterResource(R.drawable.badge_failed), contentDescription = null, tint = tone, modifier = Modifier.size(12.dp))
                step.state == StepState.DONE -> Icon(Icons.Filled.Check, contentDescription = null, tint = tone, modifier = Modifier.size(13.dp))
                else -> Box(Modifier.size(10.dp).border(1.25.dp, tone, CircleShape))
            }
        }
        Text(
            step.label,
            color = tone,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = if (step.kind == StepKind.SHELL) FontFamily.Monospace else null,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        step.detail?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = colors.tertiary, maxLines = 1) }
        if (step.killable) {
            Box(
                Modifier.size(32.dp).clip(CircleShape).clickable(onClick = onStop)
                    .semantics { contentDescription = if (step.kind == StepKind.TASK) "Stop ${step.label}" else "Kill ${step.label}" },
                contentAlignment = Alignment.Center,
            ) { Icon(painterResource(R.drawable.step_stop), contentDescription = null, tint = colors.secondary, modifier = Modifier.size(18.dp)) }
        }
    }
}

// A Member under its lead, the iOS member row: one line, the picture, name and status, then unread and age.
@Composable
private fun MemberLine(row: ListRow, now: Double, modifier: Modifier) {
    val colors = Wd.colors
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        AgentAvatar(row, MEMBER_AVATAR)
        Text(row.title, style = MaterialTheme.typography.titleSmall, color = colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            row.status.orEmpty(),
            style = MaterialTheme.typography.bodySmall,
            color = colors.secondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (row.unseen > 0u) CountBadge(row.unseen, if (row.state == RowState.ENDED) colors.badge else colors.blue)
        if (row.lastActivityAt > 0) Text(ago(row.lastActivityAt, now), style = MaterialTheme.typography.bodySmall, color = colors.tertiary, maxLines = 1)
    }
}

// Auto's tray: the idle Members as pictures (a tap opens one), then `+n` past three, else a chevron that expands the
// team or, expanded, returns it to Auto.
@Composable
private fun TeamTray(row: ListRow, onOpenMember: (TrayMember) -> Unit, onToggle: () -> Unit) {
    val colors = Wd.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        for (member in row.tray) {
            Box(Modifier.clip(RoundedCornerShape(4.dp)).clickable { onOpenMember(member) }.semantics { contentDescription = "Open ${member.title}" }) {
                TrayAvatar(member, TRAY_AVATAR)
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

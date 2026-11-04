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
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.ui.draw.blur
import androidx.compose.material.icons.filled.Search
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import bi.atomic.workerdeck.app.session.Entry
import androidx.compose.foundation.background
import androidx.compose.ui.platform.testTag
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
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
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
import androidx.compose.material3.OutlinedTextField
import bi.atomic.workerdeck.core.ffi.TeamLead
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.gateway.Gateway
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.deleteAgentMessage
import bi.atomic.workerdeck.core.ffi.deleteAgentTitle
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    model: SessionsModel,
    gateways: List<Gateway>,
    onOpen: (hostId: String, sessionId: String, title: String, entry: Entry?) -> Unit,
    onOpenPast: (hostId: String, sessionId: String, title: String, conversation: Long) -> Unit,
    onAdd: () -> Unit,
    onForget: (Gateway) -> Unit,
    onNew: (hostId: String, agent: Boolean, cwd: String?) -> Unit,
) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val colors = Wd.colors
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var deleting by remember { mutableStateOf<ListRow?>(null) }
    var history by remember { mutableStateOf<ConversationsTarget?>(null) }
    val discard by model.discard.collectAsStateWithLifecycle()
    var pastOpen by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<ListRow?>(null) }
    var closing by remember { mutableStateOf<ListRow?>(null) }
    var statusing by remember { mutableStateOf<ListRow?>(null) }
    var peeking by remember { mutableStateOf<String?>(null) }
    var crossing by remember { mutableStateOf<Pair<ListRow, TeamLead>?>(null) }
    val drag = remember(model) { ListDrag(model::teamLeads) }
    val join: (ListRow, TeamLead) -> Unit = { row, lead -> if (model.crossedOwner(row, lead) != null) crossing = row to lead else model.join(row, lead) }
    val open: (ListRow, Entry?) -> Unit = { row, entry -> onOpen(row.hostId, row.sessionId, row.title, entry) }
    val red = colors.red
    val accent = colors.accent
    val events = ListEvents(
        card = CardEvents(
            onStep = { row, step -> open(row, stepEntry(step)) },
            onStopStep = { row, step -> model.stopStep(row.hostId, row.sessionId, row.conversation, step) },
            onChip = { row, kind -> model.toggleSteps(row.hostId, row.sessionId, kind) },
            onTrayMember = { onOpen(it.hostId, it.sessionId, it.title, null) },
            onToggleTeam = { model.toggleTeam(it.hostId, it.sessionId) },
        ),
        open = { open(it, null) },
        chrome = { row ->
            val leading = buildList {
                add(SwipeAction("Rename", accent) { renaming = row })
                if (row.canNewConversation && row.newConversationBlocked == null) add(SwipeAction("New conversation", INDIGO) { model.newConversation(row) })
            }
            val trailing = when {
                row.agentId != null -> SwipeAction("Delete agent", red) { deleting = row }
                row.sessionStatus == "closed" -> SwipeAction("Remove", red) { model.close(row) }
                else -> SwipeAction("Close", red) { closing = row }
            }
            RowChrome(leading, listOf(trailing))
        },
        peek = { peeking = it.key },
        drop = { action ->
            when (action) {
                is DropAction.MoveGroup -> model.moveGroup(action.key, action.onto)
                is DropAction.Join -> join(action.row, action.lead)
                is DropAction.Leave -> model.leave(action.row)
            }
        },
        toggleGroup = model::toggleGroup,
        newIn = { hostId, cwd -> onNew(hostId, false, cwd) },
    )
    LaunchedEffect(ui.notice) {
        ui.notice?.let {
            scope.launch { snackbar.showSnackbar(it) }
            model.noticeShown()
        }
    }
    BackHandler(enabled = ui.search.isNotEmpty()) { model.setSearch("") }
    val peeked = peeking?.let { key -> ui.groups.firstNotNullOfOrNull { group -> group.rows.firstOrNull { it.key == key } } }
    Box(Modifier.fillMaxSize()) {
        Scaffold(
            modifier = Modifier.blur(if (peeked != null) 16.dp else 0.dp),
            containerColor = colors.background,
            snackbarHost = { SnackbarHost(snackbar) },
            contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Top),
            bottomBar = {
                SearchBar(ui.search, model::setSearch) { NewMenu(gateways, model::canCreateAgent) { id, agent -> onNew(id, agent, null) } }
            },
            topBar = {
                CenterAlignedTopAppBar(
                    title = { Text("Sessions", style = MaterialTheme.typography.titleMedium) },
                    actions = {
                        GatewayMenu(
                            gateways,
                            onAdd,
                            onForget,
                            onPastAgents = if (ui.pastAgents.isNotEmpty()) ({ pastOpen = true }) else null,
                            onResetOrder = if (ui.orderCustomized) model::resetGroupOrder else null,
                        )
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
                    else -> SessionsList(ui.groups, ui.error, ui.projectIcons, drag, events)
                }
            }
        }
        peeked?.let { row ->
            SessionPeekOverlay(
                row,
                model.client(row.hostId),
                peekActions(
                    row,
                    leads = model.teamLeads(row),
                    onRename = { renaming = row },
                    onStatus = { statusing = row },
                    onNewConversation = { model.newConversation(row) },
                    onConversations = { history = ConversationsTarget(row.hostId, row.sessionId, row.agent ?: row.title, row.title, retired = false) },
                    onChangeAvatar = { model.changeAvatar(row) },
                    onMakeAgent = { model.makeAgent(row) },
                    onSleep = { model.sleep(row.hostId, row.sessionId, row.conversation) },
                    onJoin = { join(row, it) },
                    onLeave = { model.leave(row) },
                    onDissolve = { model.dissolve(row) },
                    onClose = { if (row.sessionStatus == "closed") model.close(row) else closing = row },
                    onDelete = { deleting = row },
                ),
                onSeen = { model.mark(row.hostId, row.sessionId, it) },
                onLeave = { seen -> seen?.let { model.finalizeSeen(row.hostId, row.sessionId, it) } },
                onOpen = {
                    peeking = null
                    open(row, null)
                },
                onDismiss = { peeking = null },
            )
        }
    }
    statusing?.let { row -> StatusDialog(row, onDismiss = { statusing = null }) { text -> model.setStatus(row, text) } }
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
    renaming?.let { row -> RenameDialog(row, onDismiss = { renaming = null }) { text -> model.rename(row, text) } }
    closing?.let { row ->
        AlertDialog(
            onDismissRequest = { closing = null },
            title = { Text("Close ${row.title}?") },
            text = { Text("The run is terminated on the server. Its transcript is no longer attachable.") },
            confirmButton = {
                TextButton(onClick = {
                    closing = null
                    model.close(row)
                }) { Text("Close session", color = Wd.colors.red) }
            },
            dismissButton = { TextButton(onClick = { closing = null }) { Text("Cancel") } },
        )
    }
    crossing?.let { (row, lead) ->
        AlertDialog(
            onDismissRequest = { crossing = null },
            title = { Text("Join another owner's team?") },
            text = { Text("${lead.name} belongs to ${lead.owner ?: "another owner"}. Its team will be able to message and read this agent.") },
            confirmButton = {
                TextButton(onClick = {
                    crossing = null
                    model.join(row, lead, crossOwner = true)
                }) { Text("Join") }
            },
            dismissButton = { TextButton(onClick = { crossing = null }) { Text("Cancel") } },
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
private fun GatewayMenu(gateways: List<Gateway>, onAdd: () -> Unit, onForget: (Gateway) -> Unit, onPastAgents: (() -> Unit)?, onResetOrder: (() -> Unit)?) {
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
            onResetOrder?.let { reset ->
                DropdownMenuItem(
                    text = { Text("Reset group order") },
                    onClick = {
                        open = false
                        reset()
                    },
                )
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

private val INDIGO = Color(0xFF5856D6)

@Composable
private fun RenameDialog(row: ListRow, onDismiss: () -> Unit, onRename: (String) -> Unit) {
    var text by remember(row.key) { mutableStateOf(row.agent ?: row.title) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (row.agentId != null) "Rename agent" else "Rename session") },
        text = { OutlinedTextField(text, { text = it }, singleLine = true, placeholder = { Text(if (row.agentId != null) "Agent name" else "Session name") }) },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                onRename(text)
            }) { Text("Rename") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun StatusDialog(row: ListRow, onDismiss: () -> Unit, onSet: (String) -> Unit) {
    var text by remember(row.key) { mutableStateOf(row.statusText.orEmpty()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (row.statusText != null) "Change status" else "Set status") },
        text = { OutlinedTextField(text, { text = it }, singleLine = true, placeholder = { Text("What is it doing?") }) },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                onSet(text)
            }) { Text(if (text.isBlank() && row.statusText != null) "Clear" else "Set") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// Every non-navigating thing a card can do, the swipes' actions included, in the order iOS's long press lists them.
private fun peekActions(
    row: ListRow,
    leads: List<TeamLead>,
    onRename: () -> Unit,
    onStatus: () -> Unit,
    onNewConversation: () -> Unit,
    onConversations: () -> Unit,
    onChangeAvatar: () -> Unit,
    onMakeAgent: () -> Unit,
    onSleep: () -> Unit,
    onJoin: (TeamLead) -> Unit,
    onLeave: () -> Unit,
    onDissolve: () -> Unit,
    onClose: () -> Unit,
    onDelete: () -> Unit,
): PeekActions {
    val agent = row.agentId != null
    val bar = listOf(
        PeekAction("Rename", Icons.Filled.Edit, run = onRename),
        PeekAction("Status", Icons.Filled.Info, run = onStatus),
        PeekAction("New", Icons.Filled.Refresh, enabled = row.canNewConversation && row.newConversationBlocked == null, run = onNewConversation),
    )
    val general = buildList {
        add(PeekAction("Conversations…", Icons.AutoMirrored.Filled.List, run = onConversations))
        if (agent) add(PeekAction("Change avatar", Icons.Filled.Face, run = onChangeAvatar))
        if (!agent) add(PeekAction("Make agent", Icons.Filled.Person, run = onMakeAgent))
        if (row.canSleep) add(PeekAction("Sleep", null, run = onSleep))
    }
    val team = buildList {
        for (lead in leads) add(PeekAction("Add to ${lead.name}'s team", null) { onJoin(lead) })
        if (row.member) add(PeekAction("Leave ${row.team ?: "team"}", Icons.AutoMirrored.Filled.ExitToApp, run = onLeave))
        if (row.lead) add(PeekAction("Dissolve team", null, run = onDissolve))
    }
    val end = when {
        agent -> PeekAction("Delete agent…", Icons.Filled.Delete, danger = true, run = onDelete)
        row.sessionStatus == "closed" -> PeekAction("Remove", Icons.Filled.Delete, danger = true, run = onClose)
        else -> PeekAction("Close…", Icons.Filled.Close, danger = true, run = onClose)
    }
    return PeekActions(bar, listOf(general, team, listOf(end)))
}

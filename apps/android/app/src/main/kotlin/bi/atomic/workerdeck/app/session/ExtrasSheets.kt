package bi.atomic.workerdeck.app.session

import android.content.ClipData
import android.content.ClipboardManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.app.ui.WdColors
import bi.atomic.workerdeck.core.ffi.Fact
import bi.atomic.workerdeck.core.ffi.McpAction
import bi.atomic.workerdeck.core.ffi.McpServers
import bi.atomic.workerdeck.core.ffi.McpStatus
import bi.atomic.workerdeck.core.ffi.SessionChrome
import bi.atomic.workerdeck.core.ffi.SessionExtras
import bi.atomic.workerdeck.core.ffi.Skill
import bi.atomic.workerdeck.core.ffi.SkillRow
import bi.atomic.workerdeck.core.ffi.SkillSection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class ExtrasSheet { INFO, FILES, MCP, SKILLS }

// Every level of the `/mcp` stack reads the core's last answer; `revision` tells Compose when that answer moved.
// `generation` is the conversation the screen is attached to: an action names it, and a stale one is refused.
class McpModel(private val servers: McpServers, private val transport: Transport, private val generation: Long) {
    private val revisionState = MutableStateFlow(0)
    val revision: StateFlow<Int> = revisionState
    val core: McpServers get() = servers

    suspend fun refresh() {
        val call = servers.refreshCall()
        revisionState.update { it + 1 }
        servers.answered(transport.answer(call))
        revisionState.update { it + 1 }
    }

    suspend fun perform(server: String, action: McpAction) {
        servers.actionAnswered(transport.answer(servers.actionCall(server, action, generation)))?.let { servers.answered(transport.answer(it)) }
        revisionState.update { it + 1 }
    }
}

private sealed interface Page {
    val title: String

    data class Root(override val title: String) : Page

    data class Server(val name: String) : Page {
        override val title get() = name
    }

    data class Tools(val server: String, override val title: String) : Page

    data class Tool(val server: String, val name: String) : Page {
        override val title get() = name
    }

    data class SkillPage(val row: SkillRow) : Page {
        override val title get() = row.title
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExtrasSheetHost(
    sheet: ExtrasSheet,
    model: SessionModel,
    chrome: SessionChrome?,
    skills: List<SkillSection>,
    onUseSkill: (Skill) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = Wd.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { onDismiss() } }
    val root = when (sheet) {
        ExtrasSheet.INFO -> "Session info"
        ExtrasSheet.FILES -> "Files"
        ExtrasSheet.MCP -> "MCP servers"
        ExtrasSheet.SKILLS -> "Skills"
    }
    val pages = remember(sheet) { mutableStateListOf<Page>(Page.Root(root)) }
    val mcp = remember(sheet) { if (sheet == ExtrasSheet.MCP) model.mcpServers() else null }
    val push: (Page) -> Unit = { pages.add(it) }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        containerColor = if (colors.dark) colors.raised else colors.background,
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = pages.size == 1),
    ) {
        BackHandler(enabled = pages.size > 1) { pages.removeAt(pages.lastIndex) }
        Column(Modifier.navigationBarsPadding()) {
            StackHeader(pages.last().title, deep = pages.size > 1, onBack = { pages.removeAt(pages.lastIndex) }, onClose = close)
            Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
                when (val page = pages.last()) {
                    is Page.Root -> when (sheet) {
                        ExtrasSheet.INFO, ExtrasSheet.FILES -> InfoBody(model, chrome)
                        ExtrasSheet.MCP -> mcp?.let { McpRoot(it, push) }
                        ExtrasSheet.SKILLS -> SkillsRoot(skills, push)
                    }
                    is Page.Server -> mcp?.let { McpServerBody(it, page.name, push) }
                    is Page.Tools -> mcp?.let { McpToolsBody(it, page.server, push) }
                    is Page.Tool -> mcp?.let { McpToolBody(it, page.server, page.name) }
                    is Page.SkillPage -> SkillBody(page.row) {
                        onUseSkill(it)
                        close()
                    }
                }
            }
        }
    }
}

@Composable
private fun StackHeader(title: String, deep: Boolean, onBack: () -> Unit, onClose: () -> Unit) {
    val colors = Wd.colors
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 14.dp)) {
        IconButton(
            onClick = if (deep) onBack else onClose,
            modifier = Modifier.size(34.dp).background(colors.secondary.copy(alpha = 0.18f), CircleShape).align(Alignment.CenterStart),
        ) {
            Icon(
                if (deep) Icons.AutoMirrored.Filled.ArrowBack else Icons.Filled.Close,
                contentDescription = if (deep) "Back" else "Close",
                tint = colors.secondary,
                modifier = Modifier.size(16.dp),
            )
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = colors.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center).padding(horizontal = 44.dp),
        )
    }
}

@Composable
private fun InfoBody(model: SessionModel, chrome: SessionChrome?) {
    val facts by model.extras.collectAsStateWithLifecycle()
    SheetSection {
        val rows = listOfNotNull(
            chrome?.modelLabel?.let { "Model" to it },
            chrome?.modeLabel?.let { "Permission mode" to it },
            "Engine" to facts.engine,
            facts.profile?.let { "Profile" to it },
            facts.apiKeySource?.let { "Credentials" to it },
        )
        rows.forEachIndexed { index, (label, value) ->
            if (index > 0) SheetDivider()
            LabelRow(label, value, Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
        }
    }
    val copyable = listOfNotNull(facts.cwd?.let { "Working directory" to it }, facts.sdkSessionId?.let { "SDK session id" to it })
    if (copyable.isNotEmpty()) {
        Box(Modifier.padding(top = 16.dp))
        SheetSection {
            copyable.forEachIndexed { index, (label, value) ->
                if (index > 0) SheetDivider()
                CopyRow(label, value)
            }
        }
    }
}

@Composable
private fun CopyRow(label: String, value: String) {
    val colors = Wd.colors
    val context = LocalContext.current
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, value)) }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = colors.secondary)
            Text(value, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = colors.primary)
        }
        Text("Copy", style = MaterialTheme.typography.labelMedium, color = colors.accent)
    }
}

private fun mcpTint(status: McpStatus, colors: WdColors): Color = when (status) {
    McpStatus.CONNECTED -> colors.green
    McpStatus.FAILED -> colors.red
    McpStatus.NEEDS_AUTH -> colors.orange
    McpStatus.PENDING -> colors.orange.copy(alpha = 0.6f)
    McpStatus.OTHER -> colors.secondary
}

@Composable
private fun StatusDot(status: McpStatus) {
    Box(Modifier.size(8.dp).background(mcpTint(status, Wd.colors), CircleShape))
}

@Composable
private fun McpRoot(mcp: McpModel, push: (Page) -> Unit) {
    val colors = Wd.colors
    val revision by mcp.revision.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LaunchedEffect(mcp) { mcp.refresh() }
    val core = remember(revision) { mcp.core }
    when {
        core.loading() -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = colors.secondary)
        }
        core.isEmpty() -> EmptyNote("No MCP servers", core.error() ?: "This session has no MCP servers configured.")
        else -> {
            core.sections().forEach { section ->
                SheetHeading(section.title)
                SheetSection {
                    section.servers.forEachIndexed { index, server ->
                        if (index > 0) SheetDivider()
                        NavRow(onClick = { push(Page.Server(server.name)) }) {
                            StatusDot(server.tint)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(server.name, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, color = colors.primary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                                Text(listOfNotNull(server.status, server.tools).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = colors.secondary)
                            }
                        }
                    }
                }
            }
            core.error()?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.orange, modifier = Modifier.padding(top = 10.dp)) }
            Row(
                Modifier.padding(top = 14.dp).clickable { scope.launch { mcp.refresh() } }.padding(4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Filled.Refresh, contentDescription = null, tint = colors.accent, modifier = Modifier.size(16.dp))
                Text("Refresh", style = MaterialTheme.typography.labelLarge, color = colors.accent)
            }
        }
    }
}

@Composable
private fun McpServerBody(mcp: McpModel, name: String, push: (Page) -> Unit) {
    val colors = Wd.colors
    val revision by mcp.revision.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var inFlight by remember { mutableStateOf<McpAction?>(null) }
    val server = remember(revision, name) { mcp.core.server(name) } ?: return
    SheetSection {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Status", style = MaterialTheme.typography.bodyLarge, color = colors.primary, modifier = Modifier.weight(1f))
            StatusDot(server.tint)
            Text(server.status, style = MaterialTheme.typography.bodyLarge, color = colors.secondary, modifier = Modifier.padding(start = 6.dp))
        }
        FactRows(server.facts, leadingDivider = true)
    }
    server.toolCount?.let { count ->
        Box(Modifier.padding(top = 16.dp))
        SheetSection {
            NavRow(onClick = { push(Page.Tools(name, mcp.core.toolsTitle(name))) }) {
                Text("Tools", style = MaterialTheme.typography.bodyLarge, color = colors.primary, modifier = Modifier.weight(1f))
                Text("$count", style = MaterialTheme.typography.bodyLarge, color = colors.secondary)
            }
        }
    }
    if (server.actions.isNotEmpty()) {
        Box(Modifier.padding(top = 16.dp))
        SheetSection {
            server.actions.forEachIndexed { index, action ->
                if (index > 0) SheetDivider()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = inFlight == null) {
                            inFlight = action
                            scope.launch {
                                mcp.perform(name, action)
                                inFlight = null
                            }
                        }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val title = when (action) {
                        McpAction.RECONNECT -> "Reconnect"
                        McpAction.ENABLE -> "Enable"
                        McpAction.DISABLE -> "Disable"
                    }
                    Text(title, style = MaterialTheme.typography.bodyLarge, color = colors.accent, modifier = Modifier.weight(1f))
                    if (inFlight == action) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = colors.secondary)
                }
            }
        }
        mcp.core.error()?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.orange, modifier = Modifier.padding(start = 4.dp, end = 4.dp, top = 10.dp)) }
        Footnote("Applies to this session only. Your .mcp.json is untouched.")
    }
}

@Composable
private fun McpToolsBody(mcp: McpModel, server: String, push: (Page) -> Unit) {
    val colors = Wd.colors
    val revision by mcp.revision.collectAsStateWithLifecycle()
    var query by remember { mutableStateOf("") }
    val tools = remember(revision, server, query) { mcp.core.tools(server, query) }
    Box(Modifier.fillMaxWidth().background(colors.secondary.copy(alpha = 0.12f), RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 10.dp)) {
        if (query.isEmpty()) Text("Filter tools", style = MaterialTheme.typography.bodyMedium, color = colors.tertiary)
        BasicTextField(
            query,
            { query = it },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.primary),
            cursorBrush = SolidColor(colors.accent),
            modifier = Modifier.fillMaxWidth(),
        )
    }
    Box(Modifier.padding(top = 12.dp))
    SheetSection {
        tools.forEachIndexed { index, tool ->
            if (index > 0) SheetDivider()
            NavRow(onClick = { push(Page.Tool(server, tool.name)) }) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(tool.name, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, color = colors.primary)
                    tool.title?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.secondary) }
                    tool.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
    }
}

@Composable
private fun McpToolBody(mcp: McpModel, server: String, name: String) {
    val colors = Wd.colors
    val revision by mcp.revision.collectAsStateWithLifecycle()
    val tool = remember(revision, server, name) { mcp.core.tool(server, name) } ?: return
    if (tool.facts.isNotEmpty()) SheetSection { FactRows(tool.facts, leadingDivider = false) }
    tool.description?.let {
        SheetHeading("Description")
        SheetSection { Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.primary, modifier = Modifier.padding(16.dp)) }
    }
    if (tool.behaviour.isNotEmpty()) {
        SheetHeading("Behaviour")
        SheetSection { FactRows(tool.behaviour, leadingDivider = false) }
    }
    SheetHeading("Parameters")
    SheetSection {
        val parameters = tool.parameters
        if (parameters != null) {
            Text(parameters, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = colors.primary, modifier = Modifier.padding(16.dp))
        } else {
            Text(
                "Parameters are not reported by this engine: its status payload names and describes each tool but carries no input schema.",
                style = MaterialTheme.typography.bodySmall,
                color = colors.secondary,
                modifier = Modifier.padding(16.dp),
            )
        }
    }
}

@Composable
private fun FactRows(facts: List<Fact>, leadingDivider: Boolean) {
    val colors = Wd.colors
    facts.forEachIndexed { index, fact ->
        if (leadingDivider || index > 0) SheetDivider()
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(fact.label, style = MaterialTheme.typography.bodyLarge, color = if (fact.alert) colors.red else colors.primary)
            Text(fact.value, style = MaterialTheme.typography.bodyLarge, color = if (fact.alert) colors.red else colors.secondary, modifier = Modifier.weight(1f), textAlign = TextAlign.End)
        }
    }
}

@Composable
private fun SkillsRoot(sections: List<SkillSection>, push: (Page) -> Unit) {
    val colors = Wd.colors
    if (sections.isEmpty()) return EmptyNote("No skills", "This session found no skills.")
    sections.forEach { section ->
        SheetHeading(section.title)
        SheetSection {
            section.skills.forEachIndexed { index, row ->
                if (index > 0) SheetDivider()
                NavRow(onClick = { push(Page.SkillPage(row)) }) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(row.title, style = MaterialTheme.typography.bodyMedium, color = colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        row.summary?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    }
                    if (!row.skill.enabled) Text("Off", style = MaterialTheme.typography.labelSmall, color = colors.secondary)
                }
            }
        }
    }
}

// The description is shown verbatim: it is the text the model selects the skill on.
@Composable
private fun SkillBody(row: SkillRow, onUse: (Skill) -> Unit) {
    val colors = Wd.colors
    val skill = row.skill
    SheetSection {
        row.scopeLabel?.let {
            LabelRow("Scope", it, Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
            SheetDivider()
        }
        LabelRow("Status", if (skill.enabled) "Enabled" else "Disabled", Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
    }
    skill.description?.takeIf { it.isNotEmpty() }?.let {
        SheetHeading("Description")
        SheetSection { Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.secondary, modifier = Modifier.padding(16.dp)) }
    }
    if (skill.enabled) {
        Box(Modifier.padding(top = 16.dp))
        SheetSection {
            Text(
                "Use this skill",
                style = MaterialTheme.typography.bodyLarge,
                color = colors.accent,
                modifier = Modifier.fillMaxWidth().clickable { onUse(skill) }.padding(horizontal = 16.dp, vertical = 14.dp),
            )
        }
        Footnote("Writes an opening message into the composer for you to edit. It isn't sent, and there is no command that runs a skill directly.")
    }
}

@Composable
private fun NavRow(onClick: () -> Unit, content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        content()
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = Wd.colors.tertiary, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun EmptyNote(title: String, text: String) {
    val colors = Wd.colors
    Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = colors.primary)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = colors.secondary)
    }
}

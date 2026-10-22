package bi.atomic.workerdeck.app.sessions

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import bi.atomic.workerdeck.app.session.Picker
import bi.atomic.workerdeck.app.session.PickerSheet
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.Created
import bi.atomic.workerdeck.core.ffi.CreateFormFields
import bi.atomic.workerdeck.core.ffi.SdkSession
import bi.atomic.workerdeck.core.ffi.Sharing
import kotlinx.coroutines.launch

private enum class Sheet { FOLDER, MODEL, MODE, RESUME }

// Start a session or an agent. Everything past the cwd has a default, so the fast path is a recent folder and Start;
// the rest is behind Advanced. Sections the engine has no meaning for are hidden, never disabled.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateScreen(model: CreateModel, recents: List<String>, onCreated: (Created) -> Unit, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val ui by model.ui.collectAsStateWithLifecycle()
    val colors = Wd.colors
    val scope = rememberCoroutineScope()
    var sheet by remember { mutableStateOf<Sheet?>(null) }
    var advanced by rememberSaveable { mutableStateOf(ui.fields.resume.isNotEmpty()) }
    val state = ui.state
    val fields = ui.fields
    val edit = model::edit
    LaunchedEffect(model) { model.loadProfiles() }

    Scaffold(
        containerColor = colors.background,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(state.title, style = MaterialTheme.typography.titleMedium) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                actions = {
                    if (ui.submitting) {
                        CircularProgressIndicator(Modifier.padding(end = 16.dp).size(20.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(
                            onClick = { scope.launch { model.submit()?.let(onCreated) } },
                            enabled = state.canSubmit,
                        ) { Text(state.submitLabel) }
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = colors.background),
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)
                .padding(bottom = 32.dp).testTag("create-form"),
        ) {
            ui.error?.let { Text(it, color = colors.red, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 8.dp)) }

            if (state.isAgent) {
                Heading("Agent")
                Field(fields.agentName, "Name (the gateway suggests one)", capitalize = true) { v -> edit { it.copy(agentName = v) } }
                if (state.leads.isNotEmpty()) {
                    val leads = listOf<Pair<String?, String>>(null to "None") + state.leads.map { it.agentId to it.name }
                    Choice("Team", leads.firstOrNull { it.first == fields.lead }?.second ?: "None", leads) { v -> edit { it.copy(lead = v) } }
                }
                if (state.showsSharing) {
                    val options = listOf(Sharing.PRIVATE to "Private", Sharing.SHARED to "Shared")
                    Choice("Sharing", options.first { it.first == state.sharing }.second, options) { v -> edit { it.copy(sharing = v) } }
                }
                Footer("An agent keeps its name, avatar and team across conversations.")
                Heading("Brief")
                Field(fields.brief, "Who this agent is and what it works on", lines = 3) { v -> edit { it.copy(brief = v) } }
                Footer("Optional. Given to the agent as standing instructions in every conversation.")
            } else {
                Heading("Name")
                Field(fields.agentName, "Name (optional)", capitalize = true, tag = "create-name") { v -> edit { it.copy(agentName = v) } }
                Footer("A named session is an agent: it keeps its name, avatar and conversations.")
            }

            Heading("Working directory")
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    Field(fields.cwd, "/Users/you/projects/app", mono = true, tag = "cwd") { v -> edit { it.copy(cwd = v) } }
                }
                TextButton(onClick = { sheet = Sheet.FOLDER }) { Text("Browse") }
            }
            if (recents.isNotEmpty()) RecentChips(recents) { v -> edit { it.copy(cwd = v) } }

            if (state.showsProfilePicker) {
                Heading("Profile")
                // Greyed in the label, never hidden: availability is display-only and the probe can be stale.
                val options = state.profiles.map { profile ->
                    profile.name to listOfNotNull(profile.name, profile.engine, "unavailable".takeIf { profile.unavailable }).joinToString("  ·  ")
                }
                Choice("Profile", fields.profile ?: "Gateway default", options) { v -> edit { it.copy(profile = v) } }
            }

            Heading("Permissions")
            PickRow("Mode", state.modeLabel) { sheet = Sheet.MODE }

            Heading("Model")
            when {
                state.hasCatalog -> PickRow("Model", state.modelLabel) { sheet = Sheet.MODEL }
                state.modelOptions.isEmpty() -> Field(fields.model, "Profile default") { v -> edit { it.copy(model = v) } }
                else -> {
                    val options = listOf("" to "Profile default") + state.modelOptions.map { it to it }
                    Choice("Model", fields.model.ifEmpty { "Profile default" }, options) { v -> edit { it.copy(model = v) } }
                }
            }
            if (state.effortOptions.isNotEmpty()) {
                val options = listOf("" to "Default") + state.effortOptions.map { it to it }
                Choice("Effort", fields.reasoningEffort.ifEmpty { "Default" }, options) { v -> edit { it.copy(reasoningEffort = v) } }
            }

            Heading("Initial prompt")
            Field(fields.prompt, "Ask for something, or leave blank", lines = 3, tag = "prompt") { v -> edit { it.copy(prompt = v) } }
            Footer("Optional. Slash commands work here too, e.g. /wrapup.")

            if (!state.isAgent) {
                Row(
                    Modifier.fillMaxWidth().clickable { advanced = !advanced }.padding(top = 22.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Advanced", style = MaterialTheme.typography.bodyLarge, color = colors.primary, modifier = Modifier.weight(1f))
                    Icon(if (advanced) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.tertiary)
                }
                if (advanced) Advanced(fields, state.settingSources, state.budgets, state.resume, state.listSessions, state.showsFork, edit) {
                    sheet = Sheet.RESUME
                }
            }
        }
    }

    when (sheet) {
        Sheet.FOLDER -> FolderPicker(model.client, onPick = { v -> edit { it.copy(cwd = v) } }, onDismiss = { sheet = null })
        Sheet.MODEL, Sheet.MODE -> PickerSheet(
            picker = if (sheet == Sheet.MODEL) Picker.MODEL else Picker.MODE,
            models = if (sheet == Sheet.MODEL) model.modelPicker else null,
            modes = if (sheet == Sheet.MODE) model.modePicker else null,
            onModel = { v -> edit { it.copy(model = v ?: "") } },
            onEffort = { v -> edit { it.copy(reasoningEffort = v ?: "") } },
            onMode = { v -> edit { it.copy(permissionMode = v) } },
            onDismiss = { sheet = null },
        )
        Sheet.RESUME -> StoredSessionSheet(model, fields.cwd.isBlank()) { sheet = null }
        null -> {}
    }
}

@Composable
private fun Advanced(
    fields: CreateFormFields,
    settingSources: Boolean,
    budgets: Boolean,
    resume: Boolean,
    listSessions: Boolean,
    showsFork: Boolean,
    edit: ((CreateFormFields) -> CreateFormFields) -> Unit,
    onBrowseStored: () -> Unit,
) {
    if (settingSources) {
        Toggle("User settings", fields.userSettings) { v -> edit { it.copy(userSettings = v) } }
        Toggle("Project settings", fields.projectSettings) { v -> edit { it.copy(projectSettings = v) } }
        Toggle("Local settings", fields.localSettings) { v -> edit { it.copy(localSettings = v) } }
    }
    Toggle("Stream partial messages", fields.partialMessages) { v -> edit { it.copy(partialMessages = v) } }
    if (budgets) {
        Field(fields.maxTurns, "Max turns (unlimited)", keyboard = KeyboardType.Number) { v -> edit { it.copy(maxTurns = v) } }
        Field(fields.maxBudgetUsd, "Max budget in USD (unlimited)", keyboard = KeyboardType.Decimal) { v -> edit { it.copy(maxBudgetUsd = v) } }
    }
    if (resume) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { Field(fields.resume, "Resume session id", mono = true) { v -> edit { it.copy(resume = v) } } }
            if (listSessions) TextButton(onClick = onBrowseStored) { Text("Stored") }
        }
        if (showsFork) {
            Toggle("Fork instead of continue", fields.forkSession, enabled = fields.resume.isNotBlank()) { v -> edit { it.copy(forkSession = v) } }
        }
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = Wd.colors.secondary, modifier = Modifier.padding(top = 22.dp, bottom = 8.dp))
}

@Composable
private fun Footer(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Wd.colors.tertiary, modifier = Modifier.padding(top = 6.dp))
}

@Composable
private fun Field(
    value: String,
    placeholder: String,
    lines: Int = 1,
    mono: Boolean = false,
    capitalize: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text,
    tag: String? = null,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        placeholder = { Text(placeholder, color = Wd.colors.tertiary) },
        singleLine = lines == 1,
        minLines = lines,
        maxLines = if (lines == 1) 1 else 8,
        textStyle = if (mono) MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
        keyboardOptions = KeyboardOptions(
            capitalization = if (capitalize) KeyboardCapitalization.Words else KeyboardCapitalization.None,
            autoCorrectEnabled = lines > 1,
            keyboardType = keyboard,
        ),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).then(tag?.let { Modifier.testTag(it) } ?: Modifier),
    )
}

@Composable
private fun PickRow(label: String, value: String, onClick: () -> Unit) {
    val colors = Wd.colors
    Row(
        Modifier.fillMaxWidth().background(colors.secondary.copy(alpha = 0.12f), RoundedCornerShape(14.dp)).clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp).semantics { contentDescription = "$label, $value" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = colors.primary)
        Spacer(Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyLarge, color = colors.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(Icons.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.tertiary, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun <T> Choice(label: String, value: String, options: List<Pair<T, String>>, onPick: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.padding(vertical = 4.dp)) {
        PickRow(label, value) { open = true }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((key, title) in options) {
                DropdownMenuItem(text = { Text(title) }, onClick = {
                    open = false
                    onPick(key)
                })
            }
        }
    }
}

@Composable
private fun Toggle(label: String, on: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = if (enabled) Wd.colors.primary else Wd.colors.tertiary, modifier = Modifier.weight(1f))
        Switch(checked = on, onCheckedChange = onChange, enabled = enabled)
    }
}

@Composable
private fun RecentChips(paths: List<String>, onPick: (String) -> Unit) {
    val colors = Wd.colors
    Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (path in paths) {
            Text(
                path.trimEnd('/').substringAfterLast('/').ifEmpty { path },
                style = MaterialTheme.typography.labelMedium,
                color = colors.primary,
                modifier = Modifier.background(colors.secondary.copy(alpha = 0.14f), CircleShape).clickable { onPick(path) }
                    .padding(horizontal = 10.dp, vertical = 5.dp).semantics { contentDescription = path },
            )
        }
    }
}

// The stored sessions the form could resume; picking one fills the id and adopts its folder.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StoredSessionSheet(model: CreateModel, wholeStore: Boolean, onDismiss: () -> Unit) {
    val colors = Wd.colors
    var stored by remember { mutableStateOf<Result<List<SdkSession>>?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) {
        stored = null
        stored = model.resumeCandidates()
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = if (colors.dark) colors.raised else colors.background,
    ) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 16.dp)) {
            Text("Resume session", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 12.dp))
            val answer = stored
            when {
                answer == null -> CircularProgressIndicator(Modifier.padding(24.dp).size(24.dp).align(Alignment.CenterHorizontally), strokeWidth = 2.dp)
                answer.isFailure -> Column(Modifier.padding(16.dp)) {
                    Text(answer.exceptionOrNull()?.message ?: "Couldn't list sessions", color = colors.red)
                    TextButton(onClick = { attempt++ }) { Text("Try again") }
                }
                answer.getOrThrow().isEmpty() -> Text(
                    if (wholeStore) "No stored sessions on this server."
                    else "No stored sessions for this directory. Clear the working directory to list every stored session.",
                    color = colors.secondary,
                    modifier = Modifier.padding(16.dp),
                )
                else -> LazyColumn(Modifier.fillMaxWidth().height(480.dp)) {
                    items(answer.getOrThrow(), key = { it.sessionId }) { session ->
                        Column(
                            Modifier.fillMaxWidth().clickable {
                                model.adopt(session)
                                onDismiss()
                            }.padding(horizontal = 16.dp, vertical = 10.dp),
                        ) {
                            Text(session.customTitle ?: session.summary, maxLines = 2, overflow = TextOverflow.Ellipsis, color = colors.primary)
                            Text(
                                listOfNotNull(session.cwdName, session.gitBranch, session.ago).joinToString("  ·  "),
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.secondary,
                            )
                        }
                    }
                }
            }
        }
    }
}

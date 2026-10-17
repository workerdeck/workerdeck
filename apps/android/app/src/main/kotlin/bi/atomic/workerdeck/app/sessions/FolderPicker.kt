package bi.atomic.workerdeck.app.sessions

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.HostEntryKind
import bi.atomic.workerdeck.core.ffi.HostFiles
import bi.atomic.workerdeck.core.ffi.HostFilesAvailability
import kotlinx.coroutines.launch

private fun lastComponent(path: String) = path.trimEnd('/').substringAfterLast('/').ifEmpty { path }

// Pick a working directory off the host: the core's `HostFiles.folders()` starts at the server's read roots and keeps
// folders and symlinks only. Every level can be entered (a row) or chosen (the bottom button).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderPicker(client: GatewayClient, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val files = remember { HostFiles.folders() }
    val scope = rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    var stack by remember { mutableStateOf(emptyList<String>()) }
    val colors = Wd.colors

    fun load() = scope.launch {
        val call = files.loadCall() ?: return@launch
        revision++
        files.rootsAnswered(client.answer(call))
        revision++
    }
    fun list(path: String) = scope.launch {
        val call = files.listCall(path, false) ?: return@launch
        revision++
        files.listed(path, client.answer(call))
        revision++
    }
    LaunchedEffect(Unit) { load() }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        // Every core read below follows `revision`, bumped around each answer.
        val availability = revision.let { files.availability() }
        val roots = files.roots()
        // One root is not a choice: start inside it.
        val here = stack.lastOrNull() ?: roots.singleOrNull()?.path
        val canPop = stack.size > (if (roots.size == 1) 1 else 0)
        val back: () -> Unit = { if (canPop) stack = stack.dropLast(1) else onDismiss() }
        BackHandler(onBack = back)
        LaunchedEffect(here) { here?.let { list(it) } }
        Scaffold(
            containerColor = colors.background,
            topBar = {
                CenterAlignedTopAppBar(
                    title = { Text(here?.let(::lastComponent) ?: "Choose folder", style = MaterialTheme.typography.titleMedium) },
                    navigationIcon = {
                        IconButton(onClick = back) {
                            if (canPop) Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                            else Icon(Icons.Filled.Close, contentDescription = "Cancel")
                        }
                    },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = colors.background),
                )
            },
            bottomBar = {
                if (here != null) {
                    Button(
                        onClick = {
                            onPick(here)
                            onDismiss()
                        },
                        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
                    ) { Text("Use ${lastComponent(here)}") }
                }
            },
        ) { padding ->
            Box(Modifier.padding(padding).fillMaxSize()) {
                when (availability) {
                    is HostFilesAvailability.Loading, is HostFilesAvailability.OutsideRoots -> Spinner()
                    is HostFilesAvailability.Unavailable -> Note(
                        "This server exposes no directories to browse. Start it with --fs-root <path> (or --cwd-root) and folders " +
                            "show up here; you can still type a path.",
                    )
                    is HostFilesAvailability.Failed -> Column(Modifier.padding(16.dp)) {
                        Text(availability.message, color = colors.red)
                        TextButton(onClick = { load() }) { Text("Try again") }
                    }
                    is HostFilesAvailability.Ready -> if (here == null) {
                        LazyColumn {
                            items(roots, key = { it.path }) { root -> Entry(root.name, root.path) { stack = listOf(root.path) } }
                        }
                    } else {
                        val entries = files.listing(here)?.entries
                        when {
                            entries == null && files.isLoading(here) -> Spinner()
                            entries == null -> Note(files.error() ?: "")
                            entries.isEmpty() -> Note("No subfolders")
                            else -> LazyColumn {
                                items(entries, key = { it.path }) { entry ->
                                    val name = if (entry.kind == HostEntryKind.SYMLINK) "${entry.name}  ↗" else entry.name
                                    Entry(name, null) { stack = (if (stack.isEmpty()) listOf(here) else stack) + entry.path }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Entry(name: String, subtitle: String?, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(name, style = MaterialTheme.typography.bodyLarge, color = Wd.colors.primary)
        subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Wd.colors.secondary) }
    }
    HorizontalDivider(Modifier.padding(start = 16.dp), color = Wd.colors.separator)
}

@Composable
private fun Spinner() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
}

@Composable
private fun Note(text: String) {
    Text(text, color = Wd.colors.secondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp))
}

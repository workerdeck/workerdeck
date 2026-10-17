package bi.atomic.workerdeck.app.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.HostEntry
import bi.atomic.workerdeck.core.ffi.HostEntryKind
import bi.atomic.workerdeck.core.ffi.HostFileContent
import bi.atomic.workerdeck.core.ffi.HostFileEditor
import bi.atomic.workerdeck.core.ffi.HostFileState
import bi.atomic.workerdeck.core.ffi.HostFiles
import bi.atomic.workerdeck.core.ffi.HttpAnswer
import bi.atomic.workerdeck.core.ffi.HttpCall
import bi.atomic.workerdeck.core.ffi.HostFilesAvailability
import kotlinx.coroutines.launch

private fun lastComponent(path: String) = path.trimEnd('/').substringAfterLast('/').ifEmpty { path }

private sealed interface FilePage {
    val path: String

    data class Dir(override val path: String) : FilePage

    data class File(override val path: String) : FilePage
}

// The session's folder on the host, browsed and edited through the core's `HostFiles.session` and `HostFileEditor`;
// every read below follows `revision`, bumped around each answer.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostFilesScreen(transport: Transport, cwd: String, onDismiss: () -> Unit) {
    val files = remember(cwd) { HostFiles.session(cwd) }
    val scope = rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    var stack by remember { mutableStateOf(listOf<FilePage>(FilePage.Dir(cwd))) }
    val colors = Wd.colors

    fun load() = scope.launch {
        val call = files.loadCall() ?: return@launch
        revision++
        files.rootsAnswered(transport.answer(call))?.let { files.cwdAnswered(transport.answer(it)) }
        revision++
    }
    fun list(path: String, force: Boolean) = scope.launch {
        val call = files.listCall(path, force) ?: return@launch
        revision++
        files.listed(path, transport.answer(call))
        revision++
    }
    LaunchedEffect(files) { load() }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val page = stack.last()
        val back: () -> Unit = { if (stack.size > 1) stack = stack.dropLast(1) else onDismiss() }
        BackHandler(onBack = back)
        val availability = revision.let { files.availability() }
        val canWrite = (availability as? HostFilesAvailability.Ready)?.canWrite == true
        val editor = remember(page) { (page as? FilePage.File)?.let { HostFileEditor(it.path) } }
        var editorRevision by remember(page) { mutableIntStateOf(0) }
        val fileState = editorRevision.let { editor?.state() }
        fun answer(call: HttpCall, read: (HttpAnswer) -> Unit) = scope.launch {
            editorRevision++
            read(transport.answer(call))
            editorRevision++
        }
        LaunchedEffect(editor) { editor?.let { answer(it.loadCall(), it::readAnswered) } }
        Scaffold(
            modifier = Modifier.imePadding(),
            containerColor = colors.background,
            topBar = {
                CenterAlignedTopAppBar(
                    title = { Text(lastComponent(page.path), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.MiddleEllipsis) },
                    navigationIcon = {
                        IconButton(onClick = back) {
                            if (stack.size > 1) Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                            else Icon(Icons.Filled.Close, contentDescription = "Close")
                        }
                    },
                    actions = {
                        when {
                            page is FilePage.Dir && availability is HostFilesAvailability.Ready ->
                                IconButton(onClick = { list(page.path, true) }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                            fileState?.saving == true -> CircularProgressIndicator(Modifier.padding(end = 16.dp).size(18.dp), strokeWidth = 2.dp)
                            fileState?.content is HostFileContent.Text && canWrite ->
                                TextButton(enabled = fileState.dirty, onClick = { editor?.saveCall()?.let { answer(it, editor::saveAnswered) } }) { Text("Save") }
                        }
                    },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = colors.background),
                )
            },
        ) { padding ->
            Box(Modifier.padding(padding).fillMaxSize()) {
                when (availability) {
                    is HostFilesAvailability.Loading -> Spinner()
                    is HostFilesAvailability.Unavailable -> Note(
                        "No file access",
                        "This server exposes no directories. Start it with --fs-root <path> (add --fs-write to allow editing) and this " +
                            "session's folder shows up here.",
                    )
                    is HostFilesAvailability.OutsideRoots -> Note(
                        "Outside the server's roots",
                        "$cwd isn't under any --fs-root this server was started with, so it won't serve files from it.",
                    )
                    is HostFilesAvailability.Failed -> Note("Couldn't reach the server", availability.message) { load() }
                    is HostFilesAvailability.Ready -> when (page) {
                        is FilePage.Dir -> {
                            LaunchedEffect(page.path) { list(page.path, false) }
                            Directory(files, page.path, revision) { entry ->
                                stack = stack + if (entry.kind == HostEntryKind.DIR) FilePage.Dir(entry.path) else FilePage.File(entry.path)
                            }
                        }
                        is FilePage.File -> editor?.let { FileBody(it, fileState, canWrite, editorRevision, { editorRevision++ }) { answer(it.loadCall(), it::readAnswered) } }
                    }
                }
            }
        }
    }
}

@Composable
private fun Directory(files: HostFiles, path: String, revision: Int, open: (HostEntry) -> Unit) {
    val colors = Wd.colors
    val listing = revision.let { files.listing(path) }
    when {
        listing == null && files.isLoading(path) -> Spinner()
        listing == null -> Note("Can't list this folder", files.error() ?: "")
        listing.entries.isEmpty() -> Note("Empty directory", "")
        else -> LazyColumn(Modifier.navigationBarsPadding()) {
            items(listing.entries, key = { it.path }) { entry ->
                val openable = entry.kind != HostEntryKind.OTHER
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = openable) { open(entry) }.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    val glyph = when (entry.kind) {
                        HostEntryKind.DIR -> "▸"
                        HostEntryKind.SYMLINK -> "↗"
                        HostEntryKind.FILE -> "·"
                        HostEntryKind.OTHER -> "?"
                    }
                    Text(glyph, color = if (entry.kind == HostEntryKind.DIR) colors.accent else colors.secondary, modifier = Modifier.width(14.dp))
                    Text(
                        entry.name,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (openable) colors.primary else colors.secondary,
                        maxLines = 1,
                        overflow = TextOverflow.MiddleEllipsis,
                        modifier = Modifier.weight(1f),
                    )
                    entry.bytes?.let { Text(byteSize(it), style = MaterialTheme.typography.bodySmall, color = colors.secondary) }
                    if (entry.kind == HostEntryKind.DIR) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.tertiary, modifier = Modifier.size(18.dp))
                }
                HorizontalDivider(Modifier.padding(start = 40.dp), thickness = 0.5.dp, color = colors.separator)
            }
            if (listing.truncated) {
                item {
                    Text(
                        "Listing truncated: this directory has more entries than the server returns.",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.secondary,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun FileBody(
    editor: HostFileEditor,
    state: HostFileState?,
    canWrite: Boolean,
    revision: Int,
    edited: () -> Unit,
    reload: () -> Unit,
) {
    val colors = Wd.colors
    when (val content = state?.content) {
        null, is HostFileContent.Loading -> Spinner()
        is HostFileContent.Failed -> Note("Can't open this file", content.message, reload)
        is HostFileContent.Binary -> Note("Binary file", "${byteSize(content.bytes)} that isn't UTF-8 text. Opening it here could only corrupt it.")
        is HostFileContent.Text -> {
            val draft = revision.let { editor.draft() }
            BasicTextField(
                value = draft,
                onValueChange = {
                    editor.setDraft(it)
                    edited()
                },
                readOnly = !canWrite,
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = colors.primary),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp).navigationBarsPadding(),
            )
            state.error?.let { message ->
                AlertDialog(
                    onDismissRequest = {
                        editor.clearError()
                        edited()
                    },
                    title = { Text(if (state.conflict) "File changed on the server" else "Save failed") },
                    text = { Text(message) },
                    confirmButton = {
                        if (state.conflict) {
                            TextButton(onClick = {
                                editor.clearError()
                                reload()
                            }) { Text("Reload", color = colors.red) }
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = {
                            editor.clearError()
                            edited()
                        }) { Text(if (state.conflict) "Keep editing" else "OK") }
                    },
                )
            }
        }
    }
}

private fun byteSize(bytes: ULong): String {
    val value = bytes.toDouble()
    return when {
        value < 1024 -> "$bytes B"
        value < 1024 * 1024 -> "%.1f KB".format(value / 1024)
        else -> "%.1f MB".format(value / (1024 * 1024))
    }
}

@Composable
private fun Spinner() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
}

@Composable
private fun Note(title: String, text: String, retry: (() -> Unit)? = null) {
    val colors = Wd.colors
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = colors.primary)
        if (text.isNotEmpty()) Text(text, style = MaterialTheme.typography.bodyMedium, color = colors.secondary, modifier = Modifier.padding(top = 6.dp))
        retry?.let { TextButton(onClick = it) { Text("Try again") } }
    }
}

package bi.atomic.workerdeck.app

import android.content.res.Configuration
import android.os.Bundle
import android.util.Log
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.metrics.performance.JankStats
import androidx.metrics.performance.PerformanceMetricsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import bi.atomic.workerdeck.BuildConfig
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewmodel.compose.viewModel
import bi.atomic.workerdeck.app.gateway.Gateway
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.app.gateway.GatewayStore
import bi.atomic.workerdeck.app.session.Entry
import bi.atomic.workerdeck.app.session.SessionScreen
import bi.atomic.workerdeck.app.sessions.CreateScreen
import bi.atomic.workerdeck.app.sessions.RecentCwds
import bi.atomic.workerdeck.app.sessions.SessionsModel
import bi.atomic.workerdeck.app.sessions.SessionsScreen
import bi.atomic.workerdeck.app.sessions.describe
import bi.atomic.workerdeck.app.ui.WorkerDeckTheme
import bi.atomic.workerdeck.core.ffi.cleartextRefusal

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = GatewayStore(applicationContext)
        if (BuildConfig.DEBUG) trackJank()
        setContent {
            WorkerDeckTheme {
                // Test tags as resource ids: the macrobenchmarks find the list, its rows and the transcript by them.
                Surface(Modifier.semantics { testTagsAsResourceId = true }, color = MaterialTheme.colorScheme.background) { App(store) }
            }
        }
    }

    // Debug builds log every janky frame with the screen it happened on: `adb logcat -s JankStats`.
    private fun trackJank() {
        JankStats.createAndTrack(window) { frame ->
            if (frame.isJank) {
                val states = frame.states.joinToString { "${it.key}=${it.value}" }
                Log.d("JankStats", "${frame.frameDurationUiNanos / 1_000_000} ms $states")
            }
        }
    }

    // The manifest keeps the activity across configuration changes, so a live session survives a theme switch or a
    // rotation; the system bars still need their icon colours re-derived.
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        enableEdgeToEdge()
    }
}

@Composable
private fun App(store: GatewayStore) {
    var gateways by remember { mutableStateOf(store.load()) }
    var adding by rememberSaveable { mutableStateOf(false) }
    var open by rememberSaveable { mutableStateOf<List<String>?>(null) }
    // hostId, then "agent" or "session"; the form itself is not saved across a process death.
    var creating by rememberSaveable { mutableStateOf<List<String>?>(null) }
    if (gateways.isEmpty() || adding) {
        BackHandler(enabled = adding) { adding = false }
        JankScreen("pairing")
        PairingScreen { url, key ->
            cleartextRefusal(url)?.let { return@PairingScreen it }
            val probe = GatewayClient(Gateway("probe", url, key))
            runCatching { probe.sessions() }.exceptionOrNull()?.let { describe(it) }
                ?: null.also {
                    store.add(url, key)
                    gateways = store.load()
                    adding = false
                }
        }
        return
    }
    val sessions: SessionsModel = viewModel()
    sessions.attach(gateways)
    val target = open
    val client = target?.let { sessions.client(it[0]) }
    val context = LocalContext.current
    val recents = remember { RecentCwds(context) }
    val create = creating
    val form = remember(create) { create?.let { sessions.createModel(it[0], it[1] == "agent", recents.of(it[0]).firstOrNull() ?: "", null) } }
    JankScreen(if (form != null) "create" else if (target == null || client == null) "sessions" else "session")
    if (create != null && form != null && target == null) {
        CreateScreen(
            form,
            recents.of(create[0]),
            onCreated = { created ->
                created.cwd?.let { recents.remember(create[0], it) }
                sessions.pullRefresh()
                creating = null
                created.sessionId?.let { id -> open = listOf(create[0], id, created.cwd?.trimEnd('/')?.substringAfterLast('/') ?: "Session") }
            },
            onBack = { creating = null },
        )
    } else if (target == null || client == null) {
        SessionsScreen(
            sessions,
            gateways,
            onOpen = { hostId, sessionId, title, entry ->
                sessions.select(hostId, sessionId)
                sessions.open(hostId, sessionId)
                open = listOf(hostId, sessionId, title) + entryParts(entry)
            },
            onAdd = { adding = true },
            onNew = { hostId, agent -> creating = listOf(hostId, if (agent) "agent" else "session") },
            onForget = { gateway ->
                recents.forget(gateway.id)
                sessions.forget(gateway)
                store.remove(gateway.id)
                gateways = store.load()
            },
        )
    } else {
        SessionScreen(
            client,
            target[1],
            target[2],
            entryOf(target.drop(3)),
            recap = sessions.recap(target[0], target[1]),
            onSeen = { sessions.mark(target[0], target[1], it) },
            onLeave = { seen -> seen?.let { sessions.finalizeSeen(target[0], target[1], it.itemCount) } },
        ) {
            sessions.markSeen(target[0], target[1])
            open = null
        }
    }
}

// Tags JankStats frames with the screen they belong to; release builds never track, so this is a cheap no-op there.
@Composable
private fun JankScreen(name: String) {
    val view = LocalView.current
    DisposableEffect(view, name) {
        val holder = PerformanceMetricsState.getHolderForHierarchy(view)
        holder.state?.putState("screen", name)
        onDispose { holder.state?.removeState("screen") }
    }
}

// The open route is saved as strings across a configuration change: kind, then id.
private fun entryParts(entry: Entry?): List<String> = when (entry) {
    is Entry.Subagent -> listOf("subagent", entry.taskId)
    is Entry.Shell -> listOf("shell", entry.shellId)
    is Entry.Reveal -> listOf("reveal", entry.toolUseId)
    null -> emptyList()
}

private fun entryOf(parts: List<String>): Entry? = when (parts.getOrNull(0)) {
    "subagent" -> Entry.Subagent(parts[1])
    "shell" -> Entry.Shell(parts[1])
    "reveal" -> Entry.Reveal(parts[1])
    else -> null
}

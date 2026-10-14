package bi.atomic.workerdeck.app

import android.content.res.Configuration
import android.os.Bundle
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
import bi.atomic.workerdeck.app.session.SessionScreen
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
        setContent {
            WorkerDeckTheme {
                Surface(color = MaterialTheme.colorScheme.background) { App(store) }
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
    if (gateways.isEmpty() || adding) {
        BackHandler(enabled = adding) { adding = false }
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
    if (target == null || client == null) {
        SessionsScreen(
            sessions,
            gateways,
            onOpen = { row ->
                sessions.markSeen(row.hostId, row.sessionId)
                open = listOf(row.hostId, row.sessionId, row.title)
            },
            onAdd = { adding = true },
            onForget = { gateway ->
                sessions.forget(gateway)
                store.remove(gateway.id)
                gateways = store.load()
            },
        )
    } else {
        SessionScreen(client, target[1], target[2]) {
            sessions.markSeen(target[0], target[1])
            open = null
        }
    }
}

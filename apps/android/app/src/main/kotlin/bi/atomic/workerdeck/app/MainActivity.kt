package bi.atomic.workerdeck.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewmodel.compose.viewModel
import bi.atomic.workerdeck.app.gateway.Gateway
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.app.gateway.gatewayName
import bi.atomic.workerdeck.app.gateway.GatewayStore
import bi.atomic.workerdeck.app.session.SessionScreen
import bi.atomic.workerdeck.app.sessions.SessionsModel
import bi.atomic.workerdeck.app.sessions.SessionsScreen
import bi.atomic.workerdeck.app.sessions.describe

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = GatewayStore(applicationContext)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface { App(store) }
            }
        }
    }
}

@Composable
private fun App(store: GatewayStore) {
    var gateway by remember { mutableStateOf(store.load()) }
    var open by rememberSaveable { mutableStateOf<List<String>?>(null) }
    val current = gateway
    if (current == null) {
        PairingScreen { url, key ->
            val probe = GatewayClient(Gateway("primary", gatewayName(url), url, key))
            runCatching { probe.sessions() }.exceptionOrNull()?.let { describe(it) }
                ?: null.also { gateway = store.save(url, key) }
        }
        return
    }
    val client = remember(current) { GatewayClient(current) }
    val sessions: SessionsModel = viewModel()
    sessions.attach(current)
    val target = open
    if (target == null) {
        SessionsScreen(
            sessions,
            current.name,
            onOpen = { row ->
                sessions.markSeen(row.hostId, row.sessionId)
                open = listOf(row.hostId, row.sessionId, row.title)
            },
            onForget = {
                store.clear()
                gateway = null
            },
        )
    } else {
        SessionScreen(client, target[1], target[2]) {
            sessions.markSeen(target[0], target[1])
            open = null
        }
    }
}

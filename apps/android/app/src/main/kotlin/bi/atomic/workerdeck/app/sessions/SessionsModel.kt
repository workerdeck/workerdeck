package bi.atomic.workerdeck.app.sessions

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import bi.atomic.workerdeck.app.gateway.Gateway
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.core.ffi.ListException
import bi.atomic.workerdeck.core.ffi.ListGroup
import bi.atomic.workerdeck.core.ffi.SessionList
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class SessionsUi(val groups: List<ListGroup> = emptyList(), val loaded: Boolean = false, val error: String? = null)

fun describe(error: Throwable): String = when (error) {
    is ListException.NotASessionList -> "Not a WorkerDeck gateway, or the auth key is wrong"
    else -> error.message?.takeIf { it.isNotBlank() } ?: "The gateway did not answer"
}

// The list is the core's `SessionList`: this model fetches, persists what the core hands back, and polls.
class SessionsModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("sessions", Context.MODE_PRIVATE)
    private val list = SessionList(prefs.getString("config", null), prefs.getString("marks", null))
    private val state = MutableStateFlow(SessionsUi())
    val ui: StateFlow<SessionsUi> = state
    private var client: GatewayClient? = null
    private var poll: Job? = null

    fun attach(gateway: Gateway) {
        if (client?.gateway == gateway) return
        client = GatewayClient(gateway)
        poll?.cancel()
        poll = viewModelScope.launch {
            while (isActive) {
                refresh()
                delay(if (list.busy()) 2_000 else 5_000)
            }
        }
    }

    suspend fun refresh() {
        val client = client ?: return
        val error = runCatching {
            list.setHost(client.gateway.id, client.gateway.name, false, client.sessions())
        }.fold(
            onSuccess = { skipped -> if (skipped > 0u) "$skipped sessions could not be read (a newer gateway?)" else null },
            onFailure = { describe(it) },
        )
        state.value = SessionsUi(list.groups(), loaded = true, error = error)
    }

    fun toggleGroup(key: String) = update { list.toggleGroup(key) }

    fun toggleTeam(hostId: String, sessionId: String) = update { list.toggleTeam(hostId, sessionId) }

    fun markSeen(hostId: String, sessionId: String) {
        if (list.markSeen(hostId, sessionId, System.currentTimeMillis().toDouble())) {
            prefs.edit().putString("marks", list.marksJson()).apply()
            state.value = state.value.copy(groups = list.groups())
        }
    }

    // Unpairing drops the gateway from the list along with its read marks; a new pairing gets a new id.
    fun forget(gateway: Gateway) {
        poll?.cancel()
        client = null
        if (list.removeHost(gateway.id)) prefs.edit().putString("marks", list.marksJson()).apply()
        state.value = SessionsUi()
    }

    fun sessionJson(hostId: String, sessionId: String): String? = list.sessionJson(hostId, sessionId)

    private fun update(change: () -> Unit) {
        change()
        prefs.edit().putString("config", list.configJson()).apply()
        state.value = state.value.copy(groups = list.groups())
    }

    override fun onCleared() {
        list.close()
    }
}

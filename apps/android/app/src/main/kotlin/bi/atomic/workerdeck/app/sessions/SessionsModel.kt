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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class SessionsUi(
    val groups: List<ListGroup> = emptyList(),
    val loaded: Boolean = false,
    val error: String? = null,
    val avatars: Map<String, AvatarFrames> = emptyMap(),
    val refreshing: Boolean = false,
)

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
    private var clients: Map<String, GatewayClient> = emptyMap()
    private var errors: Map<String, String> = emptyMap()
    private var poll: Job? = null

    // The paired gateways, in pairing order; the list merges them. Re-attaching the same set is a no-op.
    fun attach(gateways: List<Gateway>) {
        if (clients.values.map { it.gateway } == gateways) return
        val kept = clients.filterKeys { id -> gateways.any { it.id == id } }
        clients = gateways.associate { gateway -> gateway.id to (kept[gateway.id]?.takeIf { it.gateway == gateway } ?: GatewayClient(gateway)) }
        poll?.cancel()
        poll = viewModelScope.launch {
            while (isActive) {
                refresh()
                delay(if (list.busy()) 2_000 else 5_000)
            }
        }
    }

    fun pullRefresh() {
        if (clients.isEmpty() || state.value.refreshing) return
        state.value = state.value.copy(refreshing = true)
        viewModelScope.launch {
            try {
                refresh()
            } finally {
                state.value = state.value.copy(refreshing = false)
            }
        }
    }

    suspend fun refresh() {
        val current = clients
        val answers = coroutineScope { current.values.map { client -> async { client to runCatching { client.sessions() } } }.awaitAll() }
        if (clients !== current) return
        val next = mutableMapOf<String, String>()
        for ((client, answer) in answers) {
            val gateway = client.gateway
            answer.mapCatching { body -> list.setHost(gateway.id, gateway.name, false, body) }.fold(
                onSuccess = { skipped -> if (skipped > 0u) next[gateway.id] = "$skipped sessions could not be read (a newer gateway?)" },
                onFailure = { next[gateway.id] = describe(it) },
            )
        }
        errors = next
        state.value = state.value.copy(groups = list.groups(), loaded = true, error = errorText())
        fetchAvatars()
    }

    private fun errorText(): String? {
        if (errors.isEmpty()) return null
        if (clients.size == 1) return errors.values.first()
        return errors.entries.joinToString("\n") { (id, error) -> "${clients[id]?.gateway?.name ?: id}: $error" }
    }

    fun client(hostId: String): GatewayClient? = clients[hostId]

    private fun fetchAvatars() {
        for (fetch in list.avatarFetches(System.currentTimeMillis().toDouble())) {
            val client = clients[fetch.hostId]
            if (client == null) {
                list.avatarSettled(fetch.key, false, System.currentTimeMillis().toDouble())
                continue
            }
            viewModelScope.launch {
                val frames = client.image(fetch.stillPath)?.let { still ->
                    withContext(Dispatchers.Default) { decodeAvatar(still.first, client.image(fetch.busyPath)) }
                }
                list.avatarSettled(fetch.key, frames != null, System.currentTimeMillis().toDouble())
                if (frames != null && clients[fetch.hostId] === client) {
                    state.value = state.value.copy(avatars = state.value.avatars + (fetch.key to frames))
                }
            }
        }
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
        if (list.removeHost(gateway.id)) prefs.edit().putString("marks", list.marksJson()).apply()
        attach(clients.values.map { it.gateway }.filter { it.id != gateway.id })
        state.value = state.value.copy(groups = list.groups())
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

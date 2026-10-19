package bi.atomic.workerdeck.app.sessions

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import bi.atomic.workerdeck.app.gateway.Gateway
import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.app.session.BookmarkStore
import bi.atomic.workerdeck.core.ffi.ConversationFollow
import bi.atomic.workerdeck.core.ffi.ConversationItem
import bi.atomic.workerdeck.core.ffi.ConversationSelection
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.PastAgent
import bi.atomic.workerdeck.core.ffi.CreateForm
import bi.atomic.workerdeck.core.ffi.ListStep
import bi.atomic.workerdeck.core.ffi.metaCall
import bi.atomic.workerdeck.core.ffi.StepKind
import bi.atomic.workerdeck.core.ffi.ListException
import bi.atomic.workerdeck.core.ffi.ListGroup
import bi.atomic.workerdeck.core.ffi.ReadMark
import bi.atomic.workerdeck.core.ffi.SeenCounts
import bi.atomic.workerdeck.core.ffi.getSessionCall
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
    // A one-shot message for an action that failed; the screen shows it once and calls `noticeShown`.
    val notice: String? = null,
    val pastAgents: List<PastAgentEntry> = emptyList(),
    val search: String = "",
)

// A deleted agent under Past agents; its conversations open the same sheet a live agent's do.
data class PastAgentEntry(val hostId: String, val agent: PastAgent)

fun searching(search: String): Boolean = search.trim().isNotEmpty()

data class ConversationsTarget(val hostId: String, val agentId: String, val name: String, val retired: Boolean)

fun describe(error: Throwable): String = when (error) {
    is ListException.NotASessionList -> "Not a WorkerDeck gateway, or the auth key is wrong"
    else -> error.message?.takeIf { it.isNotBlank() } ?: "The gateway did not answer"
}

// The open session screen moves from `from` to `to`, the agent's current conversation.
data class Retarget(val hostId: String, val from: String, val to: String)

// The list is the core's `SessionList`: this model fetches, persists what the core hands back, and polls.
class SessionsModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("sessions", Context.MODE_PRIVATE)
    private val list = SessionList(prefs.getString("config", null), prefs.getString("marks", null))
    private val state = MutableStateFlow(SessionsUi())

    init {
        list.setSearch("")
    }

    val ui: StateFlow<SessionsUi> = state
    private var clients: Map<String, GatewayClient> = emptyMap()
    private var errors: Map<String, String> = emptyMap()
    private var poll: Job? = null
    private val recaps = mutableMapOf<String, ReadMark?>()
    private var follow: Pair<String, ConversationFollow>? = null
    private val retargetState = MutableStateFlow<Retarget?>(null)
    val retarget: StateFlow<Retarget?> = retargetState

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
        val reached = answers.filter { it.second.isSuccess }.map { it.first }
        readMetas(reached)
        for (client in reached) if (client.gateway.id !in pastRead) readPastAgents(client.gateway.id)
        follow?.let { (hostId, follow) ->
            val from = follow.current()
            follow.listed(list)?.let { retargetState.value = Retarget(hostId, from, it) }
        }
        state.value = state.value.copy(groups = draw(), loaded = true, error = errorText())
        fetchAvatars()
    }

    private val metaRead = mutableSetOf<String>()

    // Once per gateway that answered: whether it runs agents, which seeds New agent.
    private suspend fun readMetas(reached: List<GatewayClient>) {
        for (client in reached) {
            val id = client.gateway.id
            if (id in metaRead) continue
            val body = runCatching { client.perform(metaCall()) }.getOrNull() ?: continue
            if (list.setMeta(id, body)) metaRead += id
        }
    }

    private val pastRead = mutableSetOf<String>()

    private suspend fun readPastAgents(hostId: String) {
        val client = clients[hostId] ?: return
        val read = AgentCalls(client).pastAgents()
        pastRead += hostId
        if (clients[hostId] !== client) return
        val kept = state.value.pastAgents.filter { it.hostId != hostId }
        state.value = state.value.copy(pastAgents = kept + read.orEmpty().map { PastAgentEntry(hostId, it) })
    }

    fun pastAgentsChanged(hostId: String) {
        viewModelScope.launch { readPastAgents(hostId) }
    }

    suspend fun conversations(hostId: String, agentId: String): List<ConversationItem>? =
        clients[hostId]?.let { AgentCalls(it).conversations(agentId) }

    fun restart(row: ListRow) {
        val agentId = row.agentId ?: return
        if (row.newConversationBlocked != null) return
        agentAct(row, "Could not start a new conversation") { it.restart(agentId, row.sessionId).map {} }
    }

    fun deleteAgent(row: ListRow) {
        val agentId = row.agentId ?: return
        agentAct(row, "Could not delete the agent") { it.delete(agentId, row.sessionId) }
    }

    private fun agentAct(row: ListRow, failure: String, call: suspend (AgentCalls) -> Result<Unit>) {
        val client = clients[row.hostId] ?: return
        viewModelScope.launch {
            call(AgentCalls(client)).onFailure { state.value = state.value.copy(notice = "$failure: ${describe(it)}") }
            refresh()
            readPastAgents(row.hostId)
        }
    }

    private fun errorText(): String? {
        if (errors.isEmpty()) return null
        if (clients.size == 1) return errors.values.first()
        return errors.entries.joinToString("\n") { (id, error) -> "${clients[id]?.gateway?.name ?: id}: $error" }
    }

    private var linger: Job? = null

    // Auto's linger window closes on a clock, not on a poll, so the list redraws itself when the soonest one ends.
    private fun draw(): List<ListGroup> {
        val groups = list.groups(System.currentTimeMillis().toDouble())
        linger?.cancel()
        list.lingerEnds()?.let { ends ->
            linger = viewModelScope.launch {
                delay((ends - System.currentTimeMillis()).toLong().coerceAtLeast(0) + 50)
                state.value = state.value.copy(groups = draw())
            }
        }
        return groups
    }

    fun select(hostId: String, sessionId: String) {
        list.select(hostId, sessionId)
        state.value = state.value.copy(groups = draw())
    }

    fun client(hostId: String): GatewayClient? = clients[hostId]

    // Nil seed until the gateway has said it runs agents.
    fun canCreateAgent(hostId: String): Boolean = list.agentSeed(hostId, null, null) != null

    // An agent form seeds itself from the list's gateway meta, so it is built here.
    fun createModel(hostId: String, agent: Boolean, cwd: String, resume: String?): CreateModel? {
        val client = clients[hostId] ?: return null
        val form = if (agent) CreateForm.agent(cwd, list, hostId) else CreateForm.session(cwd, resume)
        return CreateModel(form, client)
    }

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

    // A search never outlives the screen: the stored config may carry one, so it is cleared at start.
    fun setSearch(text: String) {
        list.setSearch(text)
        state.value = state.value.copy(search = text, groups = draw())
    }

    fun toggleGroup(key: String) = update { list.toggleGroup(key) }

    fun toggleTeam(hostId: String, sessionId: String) = update { list.toggleTeam(hostId, sessionId) }

    // Opening reads the old mark before moving it: that is where the catch-up seam goes. Held here, not on the
    // screen, so a rotation redraws the same seam instead of one from the marks the screen has written since.
    fun open(hostId: String, sessionId: String) {
        recaps.clear()
        recaps["$hostId:$sessionId"] = list.since(hostId, sessionId)
        markSeen(hostId, sessionId)
        follow(hostId, sessionId)
    }

    // The screen's selection: an agent's card follows the agent to its next conversation, anything else stays put.
    fun follow(hostId: String, sessionId: String) {
        if (follow?.let { it.first == hostId && it.second.current() == sessionId } == true) return
        follow?.second?.close()
        follow = hostId to ConversationFollow.open(list, hostId, sessionId)
        retargetState.value = null
    }

    // A past conversation opened from an agent's history: read-only, and it never follows the agent.
    fun pin(hostId: String, sessionId: String) {
        recaps.clear()
        follow?.second?.close()
        follow = hostId to ConversationFollow(ConversationSelection.Session(hostId, sessionId), sessionId)
        retargetState.value = null
    }

    fun unfollow() {
        follow?.second?.close()
        follow = null
        retargetState.value = null
    }

    // The shown session said which conversation replaced it; the list is re-read too, in case it moved on since.
    fun superseded(hostId: String, sessionId: String, by: String) {
        val (followed, follow) = follow ?: return
        if (followed != hostId || follow.current() != sessionId) return
        follow.superseded(by, list)?.let { retargetState.value = Retarget(hostId, sessionId, it) }
        pullRefresh()
    }

    fun retargeted() {
        retargetState.value = null
    }

    fun recap(hostId: String, sessionId: String): ReadMark? = recaps["$hostId:$sessionId"]

    fun markSeen(hostId: String, sessionId: String) = saveMarks(list.markSeen(hostId, sessionId, now()))

    // Only while the session is really on screen: a mark from anywhere else is how an unread badge stops working.
    fun mark(hostId: String, sessionId: String, seen: SeenCounts) =
        saveMarks(list.mark(hostId, sessionId, seen.itemCount, seen.activity, seen.prose, seen.turns, now()))

    // The in-view marks ran off the attach snapshot's counters, so leaving trues the mark up once from a fresh read.
    fun finalizeSeen(hostId: String, sessionId: String, itemCount: UInt) {
        val client = clients[hostId] ?: return
        viewModelScope.launch {
            val answer = runCatching { client.answer(getSessionCall(sessionId)) }.getOrNull() ?: return@launch
            if (answer.status.toInt() == 200) saveMarks(list.markSession(hostId, sessionId, itemCount, answer.body, now()))
        }
    }

    private fun saveMarks(moved: Boolean) {
        if (!moved) return
        prefs.edit().putString("marks", list.marksJson()).apply()
        state.value = state.value.copy(groups = draw())
    }

    private fun now() = System.currentTimeMillis().toDouble()

    // Unpairing drops the gateway from the list along with its read marks; a new pairing gets a new id.
    fun forget(gateway: Gateway) {
        metaRead -= gateway.id
        pastRead -= gateway.id
        state.value = state.value.copy(pastAgents = state.value.pastAgents.filter { it.hostId != gateway.id })
        if (list.removeHost(gateway.id)) prefs.edit().putString("marks", list.marksJson()).apply()
        BookmarkStore.of(getApplication()).removeHost(gateway.id)
        attach(clients.values.map { it.gateway }.filter { it.id != gateway.id })
        state.value = state.value.copy(groups = draw())
    }

    fun sleep(hostId: String, sessionId: String) {
        val client = clients[hostId] ?: return
        viewModelScope.launch {
            runCatching { client.sleep(sessionId) }.fold(
                onSuccess = { refresh() },
                onFailure = { state.value = state.value.copy(notice = "Sleep failed: ${describe(it)}") },
            )
        }
    }

    // A task stops by its call id, a shell is killed by its own; the list redraws from the gateway's answer.
    fun stopStep(hostId: String, sessionId: String, step: ListStep) {
        val client = clients[hostId] ?: return
        viewModelScope.launch {
            runCatching {
                when (step.kind) {
                    StepKind.TASK -> client.stopTask(sessionId, step.toolUseId ?: return@launch)
                    StepKind.SHELL -> client.killShell(sessionId, step.key)
                    StepKind.AGENT -> return@launch
                }
            }.fold(
                onSuccess = { refresh() },
                onFailure = { state.value = state.value.copy(notice = "Stop failed: ${describe(it)}") },
            )
        }
    }

    fun noticeShown() {
        state.value = state.value.copy(notice = null)
    }

    fun sessionJson(hostId: String, sessionId: String): String? = list.sessionJson(hostId, sessionId)

    private fun update(change: () -> Unit) {
        change()
        prefs.edit().putString("config", list.configJson()).apply()
        state.value = state.value.copy(groups = draw())
    }

    override fun onCleared() {
        follow?.second?.close()
        list.close()
    }
}

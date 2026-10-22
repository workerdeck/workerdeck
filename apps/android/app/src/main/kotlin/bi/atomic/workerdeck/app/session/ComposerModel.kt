package bi.atomic.workerdeck.app.session

import androidx.compose.ui.graphics.ImageBitmap
import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.core.ffi.AttachmentChip
import bi.atomic.workerdeck.core.ffi.CompletionStep
import bi.atomic.workerdeck.core.ffi.ComposerView
import bi.atomic.workerdeck.core.ffi.DraftEdit
import bi.atomic.workerdeck.core.ffi.HttpAnswer
import bi.atomic.workerdeck.core.ffi.Outgoing
import bi.atomic.workerdeck.core.ffi.Reupload
import bi.atomic.workerdeck.core.ffi.Session
import bi.atomic.workerdeck.core.ffi.Suggestion
import bi.atomic.workerdeck.core.ffi.TokenSpan
import bi.atomic.workerdeck.core.ffi.Upload
import bi.atomic.workerdeck.core.ffi.listSessionsCall
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import bi.atomic.workerdeck.core.ffi.Composer as CoreComposer

class PickedFile(val name: String, val mediaType: String, val bytes: ByteArray, val thumbnail: ImageBitmap?)

data class ComposerUi(
    val revision: Int = 0,
    val suggestions: List<Suggestion> = emptyList(),
    val chips: List<AttachmentChip> = emptyList(),
    val thumbnails: Map<ULong, ImageBitmap> = emptyMap(),
    val error: String? = null,
)

// The core `Composer` plus what only the app can do: wait, move bytes, keep thumbnails. Every rule is the core's.
class ComposerModel(sessionId: String, private val transport: Transport, private val scope: CoroutineScope) : AutoCloseable {
    private val core = CoreComposer(sessionId)
    private val state = MutableStateFlow(ComposerUi())
    val ui: StateFlow<ComposerUi> = state
    private val staged = ConcurrentHashMap<ULong, PickedFile>()
    @Volatile private var search: Job? = null

    fun read(session: Session) {
        reupload(core.readSession(session))
        changed()
    }

    fun view(draft: String, nowMs: Long): ComposerView = core.view(draft, nowMs)

    fun tokens(draft: String): List<TokenSpan> = core.tokens(draft)

    fun edit(draft: String, cursor: Int) {
        when (val step = core.edit(draft, cursor.coerceAtLeast(0).toUInt())) {
            CompletionStep.Unchanged -> Unit
            CompletionStep.Changed -> readSuggestions()
            is CompletionStep.Search -> {
                readSuggestions()
                search?.cancel()
                search = scope.launch {
                    delay(step.delayMs.toLong())
                    if (!core.isCurrent(step.generation)) return@launch
                    val answer = transport.answer(step.call)
                    if (isActive && core.filesAnswered(step.generation, answer)) readSuggestions()
                }
            }
        }
    }

    fun accept(index: Int, draft: String, cursor: Int): DraftEdit? =
        core.accept(index.toUInt(), draft, cursor.coerceAtLeast(0).toUInt()).also { readSuggestions() }

    fun dismissSuggestions() {
        search?.cancel()
        if (core.dismissSuggestions()) readSuggestions()
    }

    fun leadingTrigger(character: String): Boolean = core.leadingTrigger(character).also { if (it) changed() }

    fun exitShell(draft: String): DraftEdit = core.exitShell(draft).also { changed() }

    fun send(draft: String, background: Boolean): Outgoing? {
        val outgoing = core.send(draft, background) ?: return null
        search?.cancel()
        if (outgoing is Outgoing.Message) staged.clear()
        state.update {
            it.copy(
                revision = it.revision + 1,
                suggestions = core.suggestions(),
                chips = core.attachments(),
                thumbnails = if (outgoing is Outgoing.Message) emptyMap() else it.thumbnails,
            )
        }
        return outgoing
    }

    // The `#` list: polled slowly, a name only has to be right when the list opens.
    suspend fun pollPeers() {
        while (scope.isActive) {
            val answer = transport.answer(listSessionsCall())
            if (answer.status.toInt() == 200 && core.setPeers(answer.body)) changed()
            delay(PEER_POLL_MS)
        }
    }

    fun refusal(mediaType: String): String? = core.refusal(mediaType)

    fun announce(message: String) = state.update { it.copy(error = message) }

    fun errorShown() = state.update { it.copy(error = null) }

    fun add(picked: PickedFile) {
        val upload = core.addAttachment(picked.name, picked.mediaType)
        if (upload == null) {
            state.update { it.copy(revision = it.revision + 1, chips = core.attachments(), error = core.takeError() ?: it.error) }
            return
        }
        staged[upload.id] = picked
        state.update { ui ->
            ui.copy(
                revision = ui.revision + 1,
                chips = core.attachments(),
                thumbnails = picked.thumbnail?.let { ui.thumbnails + (upload.id to it) } ?: ui.thumbnails,
            )
        }
        start(upload, picked)
    }

    fun retry(id: ULong) {
        val picked = staged[id] ?: return
        val upload = core.retryAttachment(id) ?: return
        readChips()
        start(upload, picked)
    }

    fun remove(id: ULong) {
        core.removeAttachment(id)
        staged.remove(id)
        state.update { it.copy(revision = it.revision + 1, chips = core.attachments(), thumbnails = it.thumbnails - id) }
    }

    // The session moved on to its next conversation: the files go up again there, under the ids the core hands out.
    private fun reupload(moves: List<Reupload>) {
        if (moves.isEmpty()) return
        val thumbnails = state.value.thumbnails.toMutableMap()
        for (move in moves) {
            val picked = staged.remove(move.replaces)
            thumbnails.remove(move.replaces)?.let { thumbnails[move.upload.id] = it }
            if (picked == null) {
                core.removeAttachment(move.upload.id)
                continue
            }
            staged[move.upload.id] = picked
            start(move.upload, picked)
        }
        state.update { it.copy(revision = it.revision + 1, chips = core.attachments(), thumbnails = thumbnails) }
    }

    private fun start(upload: Upload, picked: PickedFile) {
        scope.launch {
            val answer = runCatching { transport.upload(upload.call, picked.mediaType, picked.bytes) }.getOrElse { HttpAnswer(0u, null, "") }
            if (!core.uploaded(upload.id, answer)) return@launch
            val error = core.takeError()
            state.update { it.copy(revision = it.revision + 1, chips = core.attachments(), error = error ?: it.error) }
        }
    }

    private fun readSuggestions() = state.update { it.copy(revision = it.revision + 1, suggestions = core.suggestions()) }

    private fun readChips() = state.update { it.copy(revision = it.revision + 1, chips = core.attachments()) }

    private fun changed() = state.update { it.copy(revision = it.revision + 1) }

    override fun close() {
        search?.cancel()
        core.close()
    }

    private companion object {
        const val PEER_POLL_MS = 20_000L
    }
}

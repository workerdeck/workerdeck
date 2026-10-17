package bi.atomic.workerdeck.app.session

import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.core.LayoutRow
import bi.atomic.workerdeck.core.ShellGrid
import bi.atomic.workerdeck.core.SessionWorker
import bi.atomic.workerdeck.core.Snapshots
import bi.atomic.workerdeck.core.TranscriptLine
import bi.atomic.workerdeck.core.ffi.Changed
import bi.atomic.workerdeck.core.ffi.ConnectionState
import bi.atomic.workerdeck.core.ffi.Effect
import bi.atomic.workerdeck.core.ffi.FrameStrip
import bi.atomic.workerdeck.core.ffi.HostImageFetch
import bi.atomic.workerdeck.core.ffi.Key
import bi.atomic.workerdeck.core.ffi.Metrics
import bi.atomic.workerdeck.core.ffi.Mode
import bi.atomic.workerdeck.core.ffi.ModePicker
import bi.atomic.workerdeck.core.ffi.ModelPicker
import bi.atomic.workerdeck.core.ffi.Prompt
import bi.atomic.workerdeck.core.ffi.PromptKind
import bi.atomic.workerdeck.core.ffi.ReplayProgress
import bi.atomic.workerdeck.core.ffi.RowMenu
import bi.atomic.workerdeck.core.ffi.ScrubCluster
import bi.atomic.workerdeck.core.ffi.ScrubPeek
import bi.atomic.workerdeck.core.ffi.Session
import bi.atomic.workerdeck.core.ffi.SessionChrome
import bi.atomic.workerdeck.core.ffi.Selection
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

data class SessionUi(
    val title: String? = null,
    val connection: ConnectionState = ConnectionState.CONNECTING,
    val error: String? = null,
    val progress: ReplayProgress? = null,
    val rows: List<LayoutRow> = emptyList(),
    val startRow: Int = 0,
    val lines: List<List<TranscriptLine>> = emptyList(),
    val chrome: SessionChrome? = null,
    val modelPicker: ModelPicker? = null,
    val modePicker: ModePicker? = null,
    val prompt: Prompt? = null,
    val planLines: List<TranscriptLine> = emptyList(),
    val jump: Jump? = null,
    val rail: List<ScrubCluster> = emptyList(),
) {
    fun linesAt(row: Int): List<TranscriptLine>? = lines.getOrNull(row - startRow)
}

// Where a session opens besides its tail: a sub-agent's takeover, a shell's screen, or a tool call's row. Held until
// the replay settles, so it lands on a transcript that has the thing.
sealed interface Entry {
    data class Subagent(val taskId: String) : Entry

    data class Shell(val shellId: String) : Entry

    data class Reveal(val toolUseId: String) : Entry
}

data class Jump(val row: Int, val nonce: Long)

// The open sub-agent takeover: one agent's own rows, read through the core's frame window.
data class FrameView(
    val taskId: String,
    val strip: FrameStrip? = null,
    val rows: List<LayoutRow> = emptyList(),
    val startRow: Int = 0,
    val lines: List<List<TranscriptLine>> = emptyList(),
    val rail: List<ScrubCluster> = emptyList(),
) {
    fun linesAt(row: Int): List<TranscriptLine>? = lines.getOrNull(row - startRow)
}

// The open shell screen: `back` is how many lines the reader scrolled up from the tail (0 follows it), `shown` how many
// rows the canvas holds. A reader scrolled back stays on the same lines while output arrives.
data class ShellView(val id: String, val sized: Boolean = false, val grid: ShellGrid? = null)

// Drives one core `Session` over one socket, for as long as its screen is shown: the screen calls `close()` when it
// leaves. Everything that touches the session, the socket and the window runs on the worker's thread; effects arrive
// there too, so `handle` and the readers call the session directly.
class SessionModel(private val client: Transport, private val sessionId: String, metrics: Metrics, entry: Entry? = null) : AutoCloseable, PromptActions {
    private var pending = entry
    private val session = Session(0, true, UUID.randomUUID().toString(), metrics)
    private val state = MutableStateFlow(SessionUi())
    private val worker = SessionWorker(session, onFailure = ::failed, onEffects = ::handle)
    val ui: StateFlow<SessionUi> = state
    private val shellState = MutableStateFlow<ShellView?>(null)
    val shell: StateFlow<ShellView?> = shellState
    private val frameState = MutableStateFlow<FrameView?>(null)
    val frame: StateFlow<FrameView?> = frameState
    private val menuState = MutableStateFlow<OpenRowMenu?>(null)
    val menu: StateFlow<OpenRowMenu?> = menuState
    private val peekState = MutableStateFlow<RailPeek?>(null)
    val peek: StateFlow<RailPeek?> = peekState
    private var railSize: RailSize? = null
    private var frameRailSize: RailSize? = null
    private var bookmarkIds: List<String> = emptyList()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val composer = ComposerModel(sessionId, client, scope)

    fun hostImagePath(path: String): HostImageFetch = session.hostImagePath(sessionId, path)
    private var socket: WebSocket? = null

    // Socket callbacks run on OkHttp's threads, possibly before the worker has stored the socket, so each socket
    // carries its generation and a callback from a replaced one is dropped by comparing numbers, not references.
    @Volatile private var generation = 0

    init {
        worker.act { it.setWallClock(System.currentTimeMillis().toDouble()) + it.setNavigation(true, true) + it.takeEffects() }
    }

    fun resize(metrics: Metrics) = worker.act { it.resize(metrics) }

    fun press(row: Int, line: Int) = worker.act { it.pressLine(row.toUInt(), line.toUInt()) }

    fun reconnect() = worker.act { it.reconnectNow() }

    // A long-press asks the core what this row offers; a row with nothing to offer opens no menu.
    fun openMenu(row: Int, inFrame: Boolean) = worker.act { session ->
        val taskId = frameState.value?.taskId
        val menu = if (inFrame) taskId?.let { session.frameRowMenu(it, row.toUInt()) } else session.rowMenu(row.toUInt())
        menuState.value = menu
            ?.takeIf { it.bookmarkItemId != null || it.copyText != null || it.backgroundCallId != null }
            ?.let { OpenRowMenu(row, inFrame, it) }
        emptyList()
    }

    fun closeMenu() {
        menuState.value = null
    }

    fun backgroundTask(toolUseId: String?) = worker.act { it.backgroundTask(toolUseId) }

    fun send(text: String, attachmentIds: List<String>) = worker.act { it.send(text, attachmentIds) }

    fun runShell(command: String) = worker.act { it.runShell(command) }

    fun interrupt() = worker.act { it.interrupt() }

    fun clearContext() = worker.act { it.clearContext() }

    fun openShell(id: String, cols: Int, rows: Int) = worker.act {
        shellState.value = (shellState.value ?: ShellView(id)).copy(sized = true)
        it.openShell(id, null, cols.toUInt(), rows.toUInt()).also { readShell() }
    }

    fun resizeShell(id: String, cols: Int, rows: Int) = worker.act {
        it.shellResize(id, cols.toUInt(), rows.toUInt()).also { readShell() }
    }

    fun scrollShell(lines: Int) = worker.act { session ->
        session.shellScroll(shellState.value?.id ?: return@act emptyList(), lines).also { readShell() }
    }

    fun shellKey(id: String, key: Key) = worker.act { it.shellKey(id, key) }

    fun shellText(id: String, text: String) = worker.act { it.shellText(id, text) }

    fun shellPaste(id: String, text: String) = worker.act { it.shellPaste(id, text) }

    fun killShell(id: String) = worker.act { it.killShell(id) }

    fun closeShell(id: String) = worker.act {
        shellState.value = null
        it.closeShell(id)
    }

    fun openFrame(taskId: String) = worker.act {
        frameState.value = FrameView(taskId)
        it.openFrame(taskId)
    }

    fun closeFrame(taskId: String) = worker.act {
        if (frameState.value?.taskId == taskId) frameState.value = null
        it.closeFrame(taskId)
    }

    fun framePress(row: Int, line: Int) = worker.act { session ->
        session.framePressLine(frameState.value?.taskId ?: return@act emptyList(), row.toUInt(), line.toUInt())
    }

    // The rail's size in layout pixels; the clusters follow from it, the transcript and the bookmarks.
    fun railSize(railH: Double, viewportH: Double, inFrame: Boolean) = worker.act {
        val size = RailSize(railH, viewportH)
        if (inFrame) {
            frameRailSize = size
            readFrame()
        } else {
            railSize = size
            readRail()
        }
        emptyList()
    }

    fun bookmarks(ids: List<String>) = worker.act {
        if (ids != bookmarkIds) {
            bookmarkIds = ids
            readRail()
        }
        emptyList()
    }

    // What the finger is over on the rail, or `null` once it lifts.
    fun peek(cluster: ScrubCluster?, y: Double, inFrame: Boolean) = worker.act { session ->
        val taskId = if (inFrame) frameState.value?.taskId ?: return@act emptyList() else null
        peekState.value = cluster?.let { session.scrubberPeek(taskId, it, y) }?.let { RailPeek(inFrame, y, it) }
        emptyList()
    }

    fun frameVisible(first: Int, last: Int) = worker.act { session ->
        val view = frameState.value ?: return@act emptyList()
        session.frameShowRows(view.taskId, first.toUInt(), last.toUInt())?.let { bytes ->
            val lines = Snapshots.transcriptLines(bytes)
            frameState.value = frameState.value?.takeIf { it.taskId == view.taskId }?.copy(startRow = lines.startRow, lines = lines.rows)
        }
        emptyList()
    }

    fun setModel(model: String?) = worker.act { it.setModel(model) }

    fun setEffort(effort: String?) = worker.act { it.setEffort(effort) }

    fun setMode(mode: Mode) = worker.act { it.setPermissionMode(mode) }

    override fun allow(requestId: String) = worker.act { it.approve(requestId, null) }

    override fun deny(requestId: String, message: String?, interrupt: Boolean) = worker.act { it.deny(requestId, message, interrupt.takeIf { it }) }

    override fun answer(requestId: String, selections: List<Selection>) = worker.act { it.answer(requestId, selections) }

    override fun dismiss(requestId: String) = worker.act { it.dismissQuestion(requestId) }

    // The rows on screen; the core decides which lines to hold for them and answers only when that moved.
    fun visible(first: Int, last: Int) = worker.act {
        it.showRows(first.toUInt(), last.toUInt())?.let(::showLines)
        emptyList()
    }

    override fun close() {
        generation++
        scope.cancel()
        worker.act {
            socket?.close(1000, null)
            socket = null
            emptyList()
        }
        worker.close()
        composer.close()
    }

    // The core panicked and the worker stopped: nothing more will arrive, so the screen says so and drops the socket.
    private fun failed(failure: Exception) {
        generation++
        socket?.cancel()
        socket = null
        state.value = state.value.copy(error = "This session view stopped (${failure.message}). Go back and open it again.")
    }

    private fun handle(effects: List<Effect>) {
        for (effect in effects) {
            when (effect) {
                is Effect.Open -> open(effect.afterSeq)
                is Effect.Send -> {
                    val ok = socket?.send(effect.text) ?: false
                    worker.act { it.sendDone(effect.id, ok) }
                }
                is Effect.Close -> {
                    generation++
                    socket?.close(1000, null)
                    socket = null
                }
                is Effect.Request -> client.request(sessionId, effect.method, effect.path, effect.scoped) { status, body ->
                    worker.act { it.responded(effect.id, status.toUShort(), body) }
                }
                is Effect.Changed -> changed(effect.changed)
                is Effect.OpenShell -> if (shellState.value?.id != effect.shellId) shellState.value = ShellView(effect.shellId)
                is Effect.OpenSubagent -> openFrame(effect.taskId)
                is Effect.WakeAt -> Unit
            }
        }
    }

    private fun open(afterSeq: Long) {
        val mine = ++generation
        socket?.cancel()
        socket = client.socket(sessionId, afterSeq, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (mine == generation) worker.opened()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (mine == generation) worker.received(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost()

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost()

            private fun lost() {
                if (mine != generation) return
                worker.act {
                    if (mine != generation) return@act emptyList()
                    socket = null
                    it.closed(System.nanoTime() / 1e9)
                }
            }
        })
    }

    // Each part is re-read only when the core says it moved: a replay's progress ticks never touch the layout.
    private fun changed(changed: Changed) {
        if (changed.transcript) {
            state.value = state.value.copy(rows = Snapshots.transcriptLayout(session.transcriptLayout()).rows)
            showLines(session.viewportLines())
        }
        var ui = state.value
        if (changed.chrome) {
            ui = ui.copy(title = session.sessionTitle(), connection = session.connection(), error = session.takeProtocolError() ?: ui.error)
        }
        if (changed.chrome) {
            ui = ui.copy(chrome = session.chrome(), modelPicker = session.modelPicker(), modePicker = session.modePicker())
            composer.read(session)
        }
        if (changed.prompt) ui = ui.copy(prompt = session.prompt())
        if ((changed.prompt || changed.transcript) && ui.prompt?.kind == PromptKind.PLAN) {
            ui = ui.copy(planLines = Snapshots.transcriptLines(session.promptPlanLines()).rows.firstOrNull().orEmpty())
        }
        if (changed.progress || changed.transcript) ui = ui.copy(progress = session.replayProgress())
        if (changed.shells) readShell()
        state.value = ui
        if (changed.transcript || changed.prompt) readRail()
        if (changed.frames || changed.transcript || changed.prompt) readFrame()
        if (pending != null && ui.connection == ConnectionState.LIVE && ui.progress == null && ui.rows.isNotEmpty()) enter()
    }

    private fun enter() {
        when (val entry = pending) {
            is Entry.Subagent -> openFrame(entry.taskId)
            is Entry.Shell -> if (shellState.value == null) shellState.value = ShellView(entry.shellId)
            is Entry.Reveal -> session.rowForToolCall(entry.toolUseId)?.let { row ->
                state.value = state.value.copy(jump = Jump(row.toInt(), (state.value.jump?.nonce ?: 0) + 1))
            }
            null -> Unit
        }
        pending = null
    }

    private fun readFrame() {
        val view = frameState.value ?: return
        val layout = session.frameLayout(view.taskId) ?: return
        val lines = session.frameViewportLines(view.taskId)?.let(Snapshots::transcriptLines)
        frameState.value = view.copy(
            strip = session.frameStrip(view.taskId),
            rows = Snapshots.transcriptLayout(layout).rows,
            startRow = lines?.startRow ?: 0,
            lines = lines?.rows.orEmpty(),
            rail = frameRailSize?.let { session.frameScrubber(view.taskId, it.railH, it.viewportH) }.orEmpty(),
        )
    }

    private fun readRail() {
        val size = railSize ?: return
        state.value = state.value.copy(rail = session.scrubber(bookmarkIds, size.railH, size.viewportH))
    }

    private fun readShell() {
        val view = shellState.value ?: return
        if (!view.sized) return
        shellState.value = view.copy(grid = session.shellWindow(view.id)?.let(Snapshots::shellGrid))
    }

    private fun showLines(bytes: ByteArray) {
        val lines = Snapshots.transcriptLines(bytes)
        state.value = state.value.copy(startRow = lines.startRow, lines = lines.rows)
    }
}

data class RailSize(val railH: Double, val viewportH: Double)

data class RailPeek(val inFrame: Boolean, val y: Double, val peek: ScrubPeek)

data class OpenRowMenu(val row: Int, val inFrame: Boolean, val menu: RowMenu)

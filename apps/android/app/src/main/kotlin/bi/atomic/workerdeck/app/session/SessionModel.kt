package bi.atomic.workerdeck.app.session

import bi.atomic.workerdeck.app.gateway.GatewayClient
import bi.atomic.workerdeck.core.LayoutRow
import bi.atomic.workerdeck.core.SessionWorker
import bi.atomic.workerdeck.core.Snapshots
import bi.atomic.workerdeck.core.TranscriptLine
import bi.atomic.workerdeck.core.ffi.Changed
import bi.atomic.workerdeck.core.ffi.ConnectionState
import bi.atomic.workerdeck.core.ffi.Effect
import bi.atomic.workerdeck.core.ffi.Metrics
import bi.atomic.workerdeck.core.ffi.ReplayProgress
import bi.atomic.workerdeck.core.ffi.Session
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

data class SessionUi(
    val title: String? = null,
    val connection: ConnectionState = ConnectionState.CONNECTING,
    val error: String? = null,
    val progress: ReplayProgress? = null,
    val rows: List<LayoutRow> = emptyList(),
    val startRow: Int = 0,
    val lines: List<List<TranscriptLine>> = emptyList(),
) {
    fun linesAt(row: Int): List<TranscriptLine>? = lines.getOrNull(row - startRow)
}

// Drives one core `Session` over one socket, for as long as its screen is shown: the screen calls `close()` when it
// leaves. Everything that touches the session, the socket and the window runs on the worker's thread; effects arrive
// there too, so `handle` and the readers call the session directly.
class SessionModel(private val client: GatewayClient, private val sessionId: String, metrics: Metrics) : AutoCloseable {
    private val session = Session(0, true, UUID.randomUUID().toString(), metrics)
    private val worker = SessionWorker(session, onEffects = ::handle)
    private val state = MutableStateFlow(SessionUi())
    val ui: StateFlow<SessionUi> = state
    private var socket: WebSocket? = null
    private var window: IntRange? = null

    // Socket callbacks run on OkHttp's threads, possibly before the worker has stored the socket, so each socket
    // carries its generation and a callback from a replaced one is dropped by comparing numbers, not references.
    @Volatile private var generation = 0

    init {
        worker.act { it.setWallClock(System.currentTimeMillis().toDouble()) + it.takeEffects() }
    }

    fun resize(metrics: Metrics) = worker.act { it.resize(metrics) }

    fun press(row: Int, line: Int) = worker.act { it.pressLine(row.toUInt(), line.toUInt()) }

    fun reconnect() = worker.act { it.reconnectNow() }

    // The rows on screen; lines are read for them plus a margin, and re-read only once the view leaves that range.
    // A view showing the last row follows the tail.
    fun visible(first: Int, last: Int, count: Int) {
        val tail = last >= count - 1
        val ui = state.value
        val loaded = ui.startRow until ui.startRow + ui.lines.size
        if (first in loaded && last in loaded && (!tail || ui.startRow + ui.lines.size >= count)) return
        val wanted = if (tail) null else (first - MARGIN)..(last + MARGIN)
        worker.act {
            window = wanted
            readLines()
            emptyList()
        }
    }

    override fun close() {
        generation++
        worker.act {
            socket?.close(1000, null)
            socket = null
            emptyList()
        }
        worker.close()
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
                is Effect.Changed -> changed(effect.changed)
                else -> Unit
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
            readLines()
        }
        var ui = state.value
        if (changed.chrome) {
            val title = session.sessionInfoJson()?.let { runCatching { JSONObject(it).optString("title").ifEmpty { null } }.getOrNull() }
            ui = ui.copy(title = title, connection = session.connection(), error = session.takeProtocolError() ?: ui.error)
        }
        if (changed.progress || changed.transcript) ui = ui.copy(progress = session.replayProgress())
        state.value = ui
    }

    // With no window the view sits at the tail, where a session opens.
    private fun readLines() {
        val ui = state.value
        val count = ui.rows.size
        val range = window ?: ((count - WINDOW)..count)
        val start = range.first.coerceIn(0, count)
        val end = range.last.coerceIn(start, count)
        val lines = Snapshots.transcriptLines(session.transcriptLines(start.toUInt(), end.toUInt()))
        state.value = ui.copy(startRow = lines.startRow, lines = lines.rows)
    }

    private companion object {
        const val WINDOW = 80
        const val MARGIN = 40
    }
}

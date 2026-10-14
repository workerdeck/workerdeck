package bi.atomic.workerdeck.app.session

import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.core.ffi.ConnectionState
import bi.atomic.workerdeck.core.ffi.Metrics
import bi.atomic.workerdeck.core.ffi.PromptKind
import bi.atomic.workerdeck.core.ffi.Selection
import bi.atomic.workerdeck.core.ffi.toggleLabel
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionModelTest {
    private class FakeSocket : WebSocket {
        val sent = CopyOnWriteArrayList<String>()
        @Volatile var closed = false

        override fun request() = Request.Builder().url("http://test/").build()

        override fun queueSize() = 0L

        override fun send(text: String) = sent.add(text)

        override fun send(bytes: ByteString) = false

        override fun close(code: Int, reason: String?) = true.also { closed = true }

        override fun cancel() {
            closed = true
        }
    }

    private class FakeTransport : Transport {
        val sockets = CopyOnWriteArrayList<Pair<FakeSocket, WebSocketListener>>()
        val requests = CopyOnWriteArrayList<Triple<String, String, (Int, String) -> Unit>>()

        override fun socket(sessionId: String, afterSeq: Long, listener: WebSocketListener): WebSocket =
            FakeSocket().also { sockets.add(it to listener) }

        override fun request(sessionId: String, method: String, path: String, scoped: Boolean, answer: (Int, String) -> Unit) {
            requests.add(Triple(method, path, answer))
        }

        override suspend fun bytes(path: String): ByteArray? = null

        fun open(): Pair<FakeSocket, WebSocketListener> {
            val (socket, listener) = sockets.last()
            val response = Response.Builder().request(socket.request()).protocol(Protocol.HTTP_1_1).code(101).message("").build()
            listener.onOpen(socket, response)
            return socket to listener
        }
    }

    private fun eventually(what: String, check: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!check()) {
            if (System.nanoTime() > deadline) throw AssertionError("timed out waiting for $what")
            Thread.sleep(10)
        }
    }

    @Test
    fun framesFromTheSocketBecomeRowsAndTheCoreServesItsOwnRequests() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        listener.onMessage(socket, user(1, "hello"))
        listener.onMessage(socket, SHELL_ROW)
        eventually("rows") { model.ui.value.rows.size >= 2 }
        eventually("lines for the tail") { model.ui.value.linesAt(model.ui.value.rows.size - 1) != null }
        assertEquals(ConnectionState.LIVE, model.ui.value.connection)
        assertEquals("Deck work", model.ui.value.title)

        eventually("the running shell's verify") { transport.requests.isNotEmpty() }
        val (method, path, answer) = transport.requests.first()
        assertEquals("GET" to "/shells/sh_1", method to path)
        answer(404, "")

        model.close()
        eventually("the socket closed") { socket.closed }
        listener.onMessage(socket, user(3, "late"))
    }

    @Test
    fun aLostSocketReconnectsOnTheCoresSchedule() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        eventually("live") { model.ui.value.connection == ConnectionState.LIVE }
        listener.onFailure(socket, java.io.IOException("gone"), null)
        eventually("a second socket after the backoff") { transport.sockets.size == 2 }
        val (old, oldListener) = transport.sockets.first()
        oldListener.onMessage(old, user(2, "from the replaced socket"))
        model.close()
        assertTrue(transport.sockets.size == 2)
    }

    @Test
    fun aPendingQuestionIsThePromptAndItsAnswerGoesOutAsAnAllow() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        listener.onMessage(socket, QUESTION)
        eventually("the prompt") { model.ui.value.prompt != null }
        val prompt = model.ui.value.prompt!!
        assertEquals(PromptKind.QUESTION to listOf("a", "b"), prompt.kind to prompt.questions.single().options.map { it.label })
        model.answer(prompt.requestId, listOf(toggleLabel(Selection(emptyList(), "", false), "b", false)))
        eventually("the decision") { socket.sent.any { "permission_decision" in it } }
        val decision = socket.sent.first { "permission_decision" in it }
        assertTrue(decision, "\"answers\":{\"Which?\":\"b\"}" in decision && "\"behavior\":\"allow\"" in decision)
        listener.onMessage(socket, RESOLVED)
        eventually("the prompt cleared") { model.ui.value.prompt == null }
        model.close()
    }

    @Test
    fun aLongPressAsksTheCoreWhatTheRowOffers() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        listener.onMessage(socket, user(1, "Survey the tests."))
        listener.onMessage(socket, TASK)
        eventually("two rows") { model.ui.value.rows.size >= 2 }
        model.openMenu(0, inFrame = false)
        eventually("the prompt's menu") { model.menu.value?.row == 0 }
        val prompt = model.menu.value!!.menu
        assertEquals("u1" to "Survey the tests.", prompt.bookmarkItemId to prompt.copyText)
        assertEquals(null, prompt.backgroundCallId)
        model.openMenu(1, inFrame = false)
        eventually("the task's menu") { model.menu.value?.row == 1 }
        val task = model.menu.value!!.menu
        assertEquals("toolu_task", task.bookmarkItemId)
        assertEquals(null to null, task.copyText to task.backgroundCallId)
        model.closeMenu()
        model.openMenu(99, inFrame = false)
        Thread.sleep(50)
        assertEquals(null, model.menu.value)
        model.close()
    }

    @Test
    fun theRailMarksThePromptTheTaskAndABookmarkAndPeeksThem() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        listener.onMessage(socket, user(1, "Survey the tests."))
        listener.onMessage(socket, TASK)
        eventually("two rows") { model.ui.value.rows.size >= 2 }
        assertEquals(emptyList<Any>(), model.ui.value.rail)
        model.railSize(400.0, 400.0, inFrame = false)
        eventually("a rail") { model.ui.value.rail.isNotEmpty() }
        assertTrue(model.ui.value.rail.any { it.kind == "user" && it.lane == "l" })
        model.bookmarks(listOf("toolu_task"))
        eventually("the bookmark") { model.ui.value.rail.any { it.kind == "bookmark" } }
        val prompt = model.ui.value.rail.first { it.kind == "user" }
        model.peek(prompt, prompt.y, inFrame = false)
        eventually("a peek") { model.peek.value != null }
        assertEquals("Survey the tests.", model.peek.value!!.peek.lines.first().text)
        model.peek(null, 0.0, inFrame = false)
        eventually("the peek gone") { model.peek.value == null }
        model.close()
    }

    @Test
    fun aTaskRowPressOpensItsTakeoverWhichFollowsTheAgent() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        listener.onMessage(socket, user(1, "Survey the tests."))
        listener.onMessage(socket, TASK)
        listener.onMessage(socket, child(3, "Looking at the tree."))
        eventually("the task row") { model.ui.value.rows.size >= 2 && model.ui.value.linesAt(model.ui.value.rows.size - 1) != null }
        val ui = model.ui.value
        val (row, line) = ui.rows.indices.firstNotNullOf { row ->
            ui.linesAt(row)?.indexOfFirst { it.pressable }?.takeIf { it >= 0 }?.let { row to it }
        }
        model.press(row, line)
        eventually("the frame") { model.frame.value?.rows?.isNotEmpty() == true }
        val frame = model.frame.value!!
        assertEquals("toolu_task", frame.taskId)
        assertEquals("working…", frame.strip?.text)
        assertTrue(frame.linesAt(frame.rows.size - 1) != null)

        val before = frame.rows.size
        listener.onMessage(socket, child(4, "Two files."))
        listener.onMessage(socket, TASK_RESULT)
        eventually("the agent settled") { model.frame.value?.strip?.text == "done" }
        assertTrue(model.frame.value!!.rows.size > before)

        model.closeFrame("toolu_task")
        eventually("closed") { model.frame.value == null }
        model.close()
    }

    @Test
    fun anEntryWaitsForTheTranscriptThenOpensTheTakeoverOrJumpsToTheCall() {
        for (entry in listOf(Entry.Subagent("toolu_task"), Entry.Reveal("toolu_task"))) {
            val transport = FakeTransport()
            val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0), entry)
            eventually("a socket") { transport.sockets.isNotEmpty() }
            val (socket, listener) = transport.open()
            listener.onMessage(socket, ATTACHED)
            listener.onMessage(socket, user(1, "Survey the tests."))
            listener.onMessage(socket, TASK)
            listener.onMessage(socket, child(3, "Looking at the tree."))
            when (entry) {
                is Entry.Subagent -> eventually("the takeover") { model.frame.value?.taskId == "toolu_task" }
                else -> eventually("the jump") { model.ui.value.jump != null }
            }
            model.close()
        }
    }

    @Test
    fun aResultPictureOpensABoxNamedForItsToolWithItsOwnAddress() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s 1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        listener.onMessage(socket, SHOT)
        listener.onMessage(socket, SHOT_RESULT)
        eventually("the box") { model.ui.value.lines.flatten().any { it.image != null } }
        val lines = model.ui.value.lines.flatten()
        val at = lines.indexOfFirst { it.image != null }
        val image = lines[at].image!!
        assertEquals("mcp__browser__screenshot-2.png", image.name)
        assertTrue(image.placeholder, image.placeholder.startsWith("image · "))
        assertTrue(lines.size >= at + image.lines)
        assertEquals("/sessions/s%201/events/3/result?toolUseId=toolu_shot&part=1", ToolImages("s 1") { null }.path(image))
        model.close()
    }

    private companion object {
        const val SHOT =
            """{"type":"event","event":{"type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_shot","name":"mcp__browser__screenshot","input":{}}]},"parentToolUseId":null,"uuid":"a-2","seq":2,"ts":1}}"""

        const val SHOT_RESULT =
            """{"type":"event","event":{"type":"user_message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_shot","content":[{"type":"text","text":"looked"},{"type":"image_ref","part_index":1,"media_type":"image/png","bytes":340000}]}]},"parentToolUseId":null,"synthetic":true,"uuid":"r-shot","seq":3,"ts":1}}"""

        const val TASK =
            """{"type":"event","event":{"type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_task","name":"Task","input":{"description":"Survey tests","prompt":"List the test files."}}]},"parentToolUseId":null,"uuid":"a-2","seq":2,"ts":1}}"""

        const val TASK_RESULT =
            """{"type":"event","event":{"type":"user_message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_task","content":"Two test files."}]},"parentToolUseId":null,"synthetic":true,"uuid":"toolu_task:result","seq":5,"ts":1}}"""

        fun child(seq: Int, text: String) =
            """{"type":"event","event":{"type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"$text"}]},"parentToolUseId":"toolu_task","uuid":"a$seq","seq":$seq,"ts":1}}"""

        const val QUESTION =
            """{"type":"event","event":{"type":"permission_requested","seq":1,"ts":1,"request":{"id":"r1","toolName":"AskUserQuestion","toolUseId":"t1","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"a"},{"label":"b"}]}]}}}}"""

        const val RESOLVED = """{"type":"event","event":{"type":"permission_resolved","requestId":"r1","seq":2,"ts":1}}"""

        const val ATTACHED =
            """{"type":"attached","protocolVersion":1,"replayingFrom":0,"acks":true,"session":{"id":"s1","title":"Deck work","status":"running","cwd":"/r","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}"""

        const val SHELL_ROW =
            """{"type":"event","event":{"type":"user_message","parentToolUseId":null,"synthetic":true,"replay":true,"seq":2,"ts":1,"shell":{"id":"sh_1","sessionId":"s1","ordinal":1,"command":"npm run dev","label":"npm run dev","cwd":"/r","owner":"user","status":"running","startedAt":1,"bytes":0,"cols":80,"rows":24},"message":{"role":"user","content":"<local-command-stdout>${'$'} npm run dev\nlistening</local-command-stdout>"}}}"""

        fun user(seq: Int, text: String) =
            """{"type":"event","event":{"type":"user_message","message":{"role":"user","content":"$text"},"parentToolUseId":null,"uuid":"u$seq","seq":$seq,"ts":1}}"""
    }
}

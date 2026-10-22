package bi.atomic.workerdeck.app.session

import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.core.ffi.ArchivedKind
import bi.atomic.workerdeck.core.ffi.AttachmentStatus
import bi.atomic.workerdeck.core.ffi.ConnectionState
import bi.atomic.workerdeck.core.ffi.Gutter
import bi.atomic.workerdeck.core.ffi.HttpAnswer
import bi.atomic.workerdeck.core.ffi.HttpCall
import bi.atomic.workerdeck.core.ffi.Outgoing
import bi.atomic.workerdeck.core.ffi.Metrics
import bi.atomic.workerdeck.core.ffi.PromptKind
import bi.atomic.workerdeck.core.ffi.ReadMark
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

        val histories = CopyOnWriteArrayList<Long?>()

        override fun socket(sessionId: String, afterSeq: Long, conversation: Long?, listener: WebSocketListener): WebSocket =
            FakeSocket().also {
                histories.add(conversation)
                sockets.add(it to listener)
            }

        override fun request(sessionId: String, method: String, path: String, scoped: Boolean, generation: Long?, answer: (Int, String) -> Unit) {
            requests.add(Triple(method, path, answer))
        }

        override suspend fun bytes(path: String): ByteArray? = null

        val calls = CopyOnWriteArrayList<HttpCall>()
        val uploads = CopyOnWriteArrayList<Pair<HttpCall, String>>()
        @Volatile var answers: (HttpCall) -> HttpAnswer = { HttpAnswer(404u, null, "") }

        override suspend fun answer(call: HttpCall): HttpAnswer = answers(call).also { calls.add(call) }

        override suspend fun upload(call: HttpCall, mediaType: String, bytes: ByteArray): HttpAnswer =
            answers(call).also { uploads.add(call to mediaType) }

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
    fun aServerCloseIsAnsweredAndReconnectsWithoutWaitingForTheTransportToGiveUp() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        eventually("live") { model.ui.value.connection == ConnectionState.LIVE }

        listener.onClosing(socket, 1000, "conversation started")
        assertTrue(socket.closed)
        eventually("a second socket") { transport.sockets.size == 2 }
        listener.onClosed(socket, 1000, "conversation started")
        Thread.sleep(1_000)
        assertEquals(2, transport.sockets.size)
        model.close()
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
        eventually("live") { model.ui.value.connection == ConnectionState.LIVE }
        eventually("the title") { model.ui.value.title == "Deck work" }

        eventually("the running shell's verify") { transport.requests.isNotEmpty() }
        val (method, path, answer) = transport.requests.first()
        assertEquals("GET" to "/shells/sh_1", method to path)
        answer(404, "")

        model.close()
        eventually("the socket closed") { socket.closed }
        listener.onMessage(socket, user(3, "late"))
    }

    @Test
    fun aFileSearchWaitsOutItsDebounceAndOnlyTheLatestQueryGoesOut() {
        val transport = FakeTransport()
        transport.answers = { call ->
            if (call.path.startsWith("/fs/find")) {
                HttpAnswer(200u, "application/json", """{"base":"/r","matches":[{"path":"/r/ab.ts","relative":"ab.ts"}]}""")
            } else {
                HttpAnswer(404u, null, "")
            }
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        eventually("live") { model.ui.value.connection == ConnectionState.LIVE }
        eventually("the composer read the chrome") { model.composer.view("", 0).enabled }
        model.composer.edit("@a", 2)
        model.composer.edit("@ab", 3)
        eventually("the suggestion") { model.composer.ui.value.suggestions.isNotEmpty() }
        assertEquals(listOf("/fs/find?path=%2Fr&q=ab&limit=8"), transport.calls.map { it.path }.filter { it.startsWith("/fs/find") })
        assertEquals("ab.ts", model.composer.ui.value.suggestions.single().title)
        assertEquals("@ab.ts ", model.composer.accept(0, "@ab", 3)?.text)
        model.close()
    }

    @Test
    fun aDollarIntoAnEmptyFieldEntersShellModeWhenTheGatewayOffersShells() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED.replace("\"replayingFrom\":0,", "\"replayingFrom\":0,\"shell\":true,"))
        eventually("the chrome offers shells") { model.ui.value.chrome?.canRunShell == true }
        assertTrue(model.composer.leadingTrigger("$"))
        assertEquals(Gutter.SHELL, model.composer.view("", 0).gutter)
        assertEquals(Outgoing.Shell("ls"), model.composer.send("ls", false))
        model.close()
    }

    @Test
    fun anAttachmentUploadsAndItsIdGoesOutWithTheMessage() {
        val transport = FakeTransport()
        transport.answers = { call ->
            if (call.path.contains("attachments")) HttpAnswer(200u, "application/json", """{"attachment":{"id":"att_1"}}""") else HttpAnswer(404u, null, "")
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        eventually("the composer read the chrome") { model.composer.view("", 0).enabled && model.ui.value.chrome?.conversation == 1L }
        model.composer.add(PickedFile("a.txt", "text/plain", "hi".toByteArray(), null))
        eventually("the upload settled") { model.composer.ui.value.chips.singleOrNull()?.status == AttachmentStatus.Ready }
        assertEquals("text/plain", transport.uploads.single().second)
        val outgoing = model.composer.send("look", false) as Outgoing.Message
        assertEquals(listOf("att_1"), outgoing.attachmentIds)
        assertTrue(model.composer.ui.value.chips.isEmpty())
        model.close()
    }

    @Test
    fun aCutReattachesTheSameScreenAndTheStagedFilesGoUpAgain() {
        val transport = FakeTransport()
        var next = 0
        transport.answers = { call ->
            if (call.path.contains("attachments")) HttpAnswer(200u, "application/json", """{"attachment":{"id":"att_${++next}"}}""") else HttpAnswer(404u, null, "")
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        eventually("the composer read the chrome") { model.composer.view("", 0).enabled && model.ui.value.chrome?.conversation == 1L }
        model.composer.add(PickedFile("a.txt", "text/plain", "hi".toByteArray(), null))
        eventually("the upload settled") { model.composer.ui.value.chips.singleOrNull()?.status == AttachmentStatus.Ready }
        assertEquals(1L, model.ui.value.chrome?.conversation)

        listener.onClosing(socket, 1000, "conversation started")
        eventually("a second socket") { transport.sockets.size == 2 }
        val (again, againListener) = transport.open()
        againListener.onMessage(again, ATTACHED.replace("\"conversation\":1", "\"conversation\":2"))
        eventually("conversation 2") { model.ui.value.chrome?.conversation == 2L }
        eventually("the file went up again") { transport.uploads.size == 2 }
        eventually("the chip is ready again") { model.composer.ui.value.chips.singleOrNull()?.status == AttachmentStatus.Ready }
        val outgoing = model.composer.send("look", false) as Outgoing.Message
        assertEquals(listOf("att_2"), outgoing.attachmentIds)
        assertEquals(listOf<Long?>(null, null), transport.histories.toList())
        model.close()
    }

    @Test
    fun handedBackPromptsQueueUntilEachIsSettled() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        eventually("attached") { model.ui.value.chrome?.conversation == 1L }
        model.send("first", emptyList())
        model.send("second", emptyList())
        eventually("both sent") { socket.sent.count { it.contains("\"user_message\"") } == 2 }
        val ids = socket.sent.filter { it.contains("\"user_message\"") }.map { Regex("\"clientId\":\"([^\"]+)\"").find(it)!!.groupValues[1] }
        listener.onMessage(socket, """{"type":"ack","clientId":"${ids[0]}","notDelivered":true}""")
        listener.onMessage(socket, """{"type":"ack","clientId":"${ids[1]}","uncertain":true}""")
        eventually("both handed back") { model.returned.value.size == 2 }
        assertEquals(listOf("first" to false, "second" to true), model.returned.value.map { it.text to it.uncertain })
        model.settleReturned(model.returned.value.first().id)
        assertEquals(listOf("second"), model.returned.value.map { it.text })
        model.close()
    }

    @Test
    fun aPastConversationOpensItsOwnSocketAndReadsAsPastOnceTheListIsKnown() {
        val transport = FakeTransport()
        transport.answers = { call ->
            if (call.path == "/sessions/s1/conversations") HttpAnswer(200u, "application/json", """{"conversation":3,"history":[]}""") else HttpAnswer(404u, null, "")
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0), history = 2)
        eventually("a socket") { transport.sockets.isNotEmpty() }
        assertEquals(2L, transport.histories.single())
        val (socket, listener) = transport.open()
        listener.onMessage(socket, LIVE_AGENT)
        eventually("the archived view") { model.conversation.value.archived != null }
        val view = model.conversation.value.archived!!
        assertEquals(ArchivedKind.PAST, view.kind)
        assertEquals(3L, view.current)
        assertTrue(model.ui.value.chrome!!.historical)
        assertEquals(null, model.conversation.value.notice)
        model.close()
    }

    @Test
    fun aDeletedAgentsPastConversationOffersNoWayToTheCurrent() {
        val transport = FakeTransport()
        transport.answers = { call ->
            if (call.path == "/sessions/s1/conversations") HttpAnswer(200u, "application/json", """{"conversation":3,"closed":true,"history":[]}""") else HttpAnswer(404u, null, "")
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0), history = 1)
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, LIVE_AGENT)
        eventually("the archived view") { model.conversation.value.archived != null }
        assertEquals(false, model.ui.value.chrome!!.canNewConversation)
        model.close()
    }

    @Test
    fun aLiveSessionShowsItsNoticeAndItsActionsNameTheShownConversation() {
        val transport = FakeTransport()
        transport.answers = { call ->
            when {
                call.path == "/sessions/s1/conversations" && call.method == "GET" ->
                    HttpAnswer(200u, "application/json", """{"conversation":1,"history":[],"pendingPrompt":{"text":"go on","n":1,"state":"uncertain"}}""")
                call.path.startsWith("/sessions/s1/conversations") || call.path.startsWith("/agents/ag") -> HttpAnswer(200u, "application/json", "{}")
                else -> HttpAnswer(404u, null, "")
            }
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, LIVE_AGENT)
        eventually("the notice") { model.conversation.value.notice?.uncertainPrompt == "go on" }
        eventually("the chrome") { model.ui.value.chrome?.conversation == 1L }
        val chrome = model.ui.value.chrome!!
        assertEquals("ag", chrome.agentId)
        assertEquals(true, chrome.canNewConversation)
        assertEquals(null, chrome.newConversationBlocked)

        model.newConversation()
        eventually("the cut") { transport.calls.any { it.method == "POST" && it.path == "/sessions/s1/conversations" } }
        assertTrue(transport.calls.single { it.method == "POST" && it.path == "/sessions/s1/conversations" }.body!!.contains("\"expectedGeneration\":1"))

        model.settle(true)
        eventually("the settle") { transport.calls.any { it.path.endsWith("/conversations/pending") } }
        assertTrue(transport.calls.single { it.path.endsWith("/conversations/pending") }.body!!.contains("\"send\":true"))

        var deleted = false
        model.deleteAgent { deleted = true }
        eventually("the delete") { deleted }
        val retire = transport.calls.single { it.method == "DELETE" && it.path == "/agents/ag" }
        assertTrue(retire.body!!.contains("\"members\":\"release\""))
        assertTrue(retire.body!!.contains("\"expectedGeneration\":1"))
        model.close()
    }

    @Test
    fun unconfirmedInputAsksBeforeTheCutDiscardsIt() {
        val transport = FakeTransport()
        transport.answers = { call ->
            when {
                call.method == "POST" && call.path == "/sessions/s1/conversations" ->
                    HttpAnswer(409u, "application/json", """{"error":"unconfirmed","code":"unconfirmed_input","conversation":1,"inputRevision":"r.1","pendingInput":1}""")
                call.path == "/sessions/s1/conversations/discard" -> HttpAnswer(200u, "application/json", "{}")
                else -> HttpAnswer(404u, null, "")
            }
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, LIVE_AGENT)
        eventually("the chrome") { model.ui.value.chrome?.agentId == "ag" }
        model.newConversation()
        eventually("the confirmation") { model.discard.value != null }
        model.discardAndCut(model.discard.value!!)
        eventually("the discard") { transport.calls.any { it.path == "/sessions/s1/conversations/discard" } }
        assertEquals(null, model.discard.value)
        assertEquals(null, model.actionError.value)
        model.close()
    }

    @Test
    fun aRefusedActionSaysWhatFailed() {
        val transport = FakeTransport()
        transport.answers = { call ->
            if (call.method == "POST" && call.path == "/sessions/s1/conversations") HttpAnswer(409u, "application/json", """{"error":"Moved on"}""") else HttpAnswer(404u, null, "")
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, LIVE_AGENT)
        eventually("the chrome") { model.ui.value.chrome?.agentId == "ag" }
        model.newConversation()
        eventually("the error") { model.actionError.value != null }
        assertEquals("Could not start a new conversation: Moved on", model.actionError.value)
        model.close()
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

    @Test
    fun aCodexPictureIsReadFromTheHostUntilTheSessionAnnouncesItsProducedFile() {
        val transport = FakeTransport()
        val model = SessionModel(transport, "s 1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        listener.onMessage(socket, VIEW)
        eventually("the box") { model.ui.value.lines.flatten().any { it.image != null } }
        val image = model.ui.value.lines.flatten().firstNotNullOf { it.image }
        assertEquals("v.png" to "/tmp/v.png", image.name to image.hostPath)
        val images = ToolImages("s 1") { null }.also { it.host = model::hostImagePath }
        assertEquals("/fs/read?path=%2Ftmp%2Fv.png", images.path(image))
        listener.onMessage(socket, PRODUCED)
        eventually("the produced file") { images.path(image) == "/sessions/s%201/produced/f1" }
        model.close()
    }

    @Test
    fun theMetersReadTheTranscriptThenTheAccountsProfileRow() {
        val transport = FakeTransport()
        transport.answers = { call ->
            if (call.path == "/profiles") HttpAnswer(200u, "application/json", PROFILES) else HttpAnswer(404u, null, "")
        }
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0))
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, METERED)
        listener.onMessage(socket, CONTEXT_USAGE)
        listener.onMessage(socket, FIVE_HOUR)
        eventually("the context ring") { model.ui.value.usage?.context != null }
        assertEquals("62", model.ui.value.usage?.context?.ringLabel)
        eventually("the account's weekly window") { model.ui.value.usage?.windows?.any { it.key == "seven_day" } == true }
        val usage = model.ui.value.usage!!
        assertEquals(listOf("five_hour", "seven_day"), usage.windows.map { it.key }.take(2))
        assertTrue(usage.spend?.weekText.orEmpty(), usage.spend != null)
        assertEquals(1, transport.calls.count { it.path == "/profiles" })
        model.close()
    }

    @Test
    fun aReadMarkFromTheLastVisitDrawsTheSeamAndTheCatchUpBarUntilDismissed() {
        val transport = FakeTransport()
        val mark = ReadMark(1u, System.currentTimeMillis() - 42 * 60_000.0)
        val model = SessionModel(transport, "s1", Metrics(8.0, 16.0, 800.0, 13.0), recap = mark)
        eventually("a socket") { transport.sockets.isNotEmpty() }
        val (socket, listener) = transport.open()
        listener.onMessage(socket, ATTACHED)
        listener.onMessage(socket, user(1, "first"))
        (2..4).forEach { listener.onMessage(socket, reply(it, "reply $it")) }
        eventually("the catch-up bar") { model.ui.value.catchUp != null }
        val catchUp = model.ui.value.catchUp!!
        assertTrue(catchUp.text, catchUp.count > 0u)
        assertTrue(model.ui.value.rows[catchUp.row.toInt()].recap)
        eventually("what was seen") { (model.seen.value?.itemCount ?: 0u) >= 4u }
        model.clearRecap()
        eventually("the bar gone") { model.ui.value.catchUp == null && model.ui.value.rows.none { it.recap } }
        model.close()
    }

    private companion object {
        const val VIEW =
            """{"type":"event","event":{"type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_view","name":"CodexImageView","input":{"path":"/tmp/v.png"}}]},"parentToolUseId":null,"uuid":"a-2","seq":2,"ts":1}}"""

        const val PRODUCED =
            """{"type":"event","event":{"type":"file_produced","path":"/tmp/v.png","fileId":"f1","mediaType":"image/png","bytes":3,"seq":3,"ts":1}}"""

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

        val METERED =
            """{"type":"attached","protocolVersion":2,"replayingFrom":0,"session":{"id":"s1","title":"Metered","status":"idle","cwd":"/r","createdAt":1,"profile":"p1","lastSeq":0,"conversation":1,"pendingPermissionCount":0,"capabilities":${caps("\"rateLimits\":true")}}}"""

        const val CONTEXT_USAGE =
            """{"type":"event","event":{"type":"context_usage","usage":{"totalTokens":124000,"maxTokens":200000,"percentage":62,"model":"claude-opus-4-6","categories":[{"name":"Messages","tokens":98000,"color":"#497eae"}]},"seq":1,"ts":1760000001000}}"""

        const val FIVE_HOUR =
            """{"type":"event","event":{"type":"rate_limit","info":{"status":"allowed","rateLimitType":"five_hour","utilization":34},"seq":2,"ts":1760000002000}}"""

        const val PROFILES =
            """{"profiles":[{"name":"p1","usage":{"seven_day":{"info":{"status":"allowed","utilization":71},"updatedAt":1760000003000}},"spend":{"weekUsd":41.2,"monthUsd":160,"weekByModel":{},"unpricedShare":0}}]}"""

        val LIVE_AGENT =
            """{"type":"attached","protocolVersion":2,"replayingFrom":0,"session":{"id":"s1","title":"Work","status":"idle","sdkSessionId":"sdk","cwd":"/r","createdAt":1,"lastSeq":0,"conversation":1,"pendingPermissionCount":0,"capabilities":${caps("\"rateLimits\":false")},"agent":{"id":"ag","name":"WD-Test"}}}"""


        // A whole capability record (the core reads none partial), everything off but `extra`.
        fun caps(extra: String) =
            "{" + listOf(
                "\"interactiveApprovals\":false", "\"permissionModes\":[]", "\"defaultPermissionMode\":\"default\"", "\"resume\":false",
                "\"resumeBackfill\":false", "\"listSessions\":false", "\"contextUsage\":false", "\"mcpStatus\":false",
                "\"mcpServerActions\":false", "\"sessionMcpServers\":false", "\"toolFilters\":\"none\"", "\"slashCommands\":false",
                "\"skillsList\":false", "\"settingSources\":false", "\"budgets\":false", "\"attachments\":[]", "\"vfs\":false",
                "\"streaming\":\"none\"", extra,
            ).joinToString(",") + "}"

        const val ATTACHED =
            """{"type":"attached","protocolVersion":2,"replayingFrom":0,"session":{"id":"s1","title":"Deck work","status":"running","cwd":"/r","createdAt":1,"lastSeq":0,"conversation":1,"pendingPermissionCount":0}}"""

        const val SHELL_ROW =
            """{"type":"event","event":{"type":"user_message","parentToolUseId":null,"synthetic":true,"replay":true,"seq":2,"ts":1,"shell":{"id":"sh_1","sessionId":"s1","ordinal":1,"command":"npm run dev","label":"npm run dev","cwd":"/r","owner":"user","status":"running","startedAt":1,"bytes":0,"cols":80,"rows":24},"message":{"role":"user","content":"<local-command-stdout>${'$'} npm run dev\nlistening</local-command-stdout>"}}}"""

        fun reply(seq: Int, text: String) =
            """{"type":"event","event":{"type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"$text"}]},"parentToolUseId":null,"uuid":"a$seq","seq":$seq,"ts":1}}"""

        fun user(seq: Int, text: String) =
            """{"type":"event","event":{"type":"user_message","message":{"role":"user","content":"$text"},"parentToolUseId":null,"uuid":"u$seq","seq":$seq,"ts":1}}"""
    }
}

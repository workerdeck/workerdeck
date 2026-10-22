package bi.atomic.workerdeck.app.sessions

import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.core.ffi.HttpAnswer
import bi.atomic.workerdeck.core.ffi.HttpCall
import kotlinx.coroutines.runBlocking
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationCallsTest {
    private class Answers(val answer: (HttpCall) -> HttpAnswer) : Transport {
        val calls = mutableListOf<HttpCall>()

        override fun socket(sessionId: String, afterSeq: Long, conversation: Long?, listener: WebSocketListener): WebSocket = error("no socket")

        override fun request(sessionId: String, method: String, path: String, scoped: Boolean, generation: Long?, answer: (Int, String) -> Unit) = Unit

        override suspend fun bytes(path: String): ByteArray? = null

        override suspend fun answer(call: HttpCall): HttpAnswer = answer.invoke(call).also { calls.add(call) }

        override suspend fun upload(call: HttpCall, mediaType: String, bytes: ByteArray): HttpAnswer = answer.invoke(call)
    }

    @Test
    fun aSessionsHistoryComesNewestFirstWithTheCurrentOnTop() = runBlocking {
        val transport = Answers { call ->
            if (call.path == "/sessions/s/conversations") {
                HttpAnswer(200u, "application/json", """{"conversation":3,"history":[{"n":1,"engine":"claude","cwd":"/w","endedAt":1760000000000,"title":"First"},{"n":2,"engine":"claude","cwd":"/w","endedAt":1760000100000,"transcript":"unavailable"}]}""")
            } else {
                HttpAnswer(404u, null, "")
            }
        }
        val items = ConversationCalls(transport).conversations("s", "Now")!!
        assertEquals(listOf(3L to true, 2L to false, 1L to false), items.map { it.n to it.current })
        assertEquals("Now", items[0].title)
        assertTrue(items[1].unavailable)
    }

    @Test
    fun anUnansweredHistoryIsNullNotEmpty() = runBlocking {
        assertEquals(null, ConversationCalls(Answers { HttpAnswer(0u, null, "") }).conversations("s", null))
        assertEquals(null, ConversationCalls(Answers { HttpAnswer(500u, null, "") }).pastAgents())
    }

    @Test
    fun pastAgentsCountTheirConversations() = runBlocking {
        val transport = Answers {
            HttpAnswer(200u, "application/json", """{"retired":[{"id":"x","name":"Gone","retiredAt":0,"conversations":[{"n":1}]}]}""")
        }
        val past = ConversationCalls(transport).pastAgents()!!.single()
        assertEquals("x" to "Gone", past.id to past.name)
        assertTrue(past.detail.endsWith("1 conversation"))
        assertEquals("/agents?retired=1", transport.calls.single().path)
    }

    @Test
    fun aNewConversationNamesTheConversationItWasWrittenFor() = runBlocking {
        val transport = Answers { HttpAnswer(200u, "application/json", "{}") }
        assertEquals(CutAnswer.Done, ConversationCalls(transport).newConversation("s", 4))
        val call = transport.calls.single()
        assertEquals("POST" to "/sessions/s/conversations", call.method to call.path)
        assertTrue(call.body!!.contains("\"expectedGeneration\":4"))
    }

    @Test
    fun unconfirmedInputAsksBeforeItIsDiscarded() = runBlocking {
        val refused = Answers {
            HttpAnswer(409u, "application/json", """{"error":"unconfirmed input","code":"unconfirmed_input","conversation":4,"inputRevision":"r.2","pendingInput":1}""")
        }
        val calls = ConversationCalls(refused)
        val answer = calls.newConversation("s", 4) as CutAnswer.Discard
        assertEquals(4L to "r.2", answer.confirmation.conversation to answer.confirmation.inputRevision)
        calls.discardAndCut("s", answer.confirmation)
        val discard = refused.calls.last()
        assertEquals("/sessions/s/conversations/discard", discard.path)
        assertTrue(discard.body!!.contains("\"inputRevision\":\"r.2\""))
    }

    @Test
    fun aFailureCarriesTheGatewaysWords() = runBlocking {
        val gone = ConversationCalls(Answers { HttpAnswer(0u, null, "") }).delete("ag", 2)
        assertEquals("The gateway did not answer", gone.exceptionOrNull()?.message)
        val busy = ConversationCalls(Answers { HttpAnswer(409u, "application/json", """{"error":"session is running"}""") })
        assertEquals(CutAnswer.Failed("session is running"), busy.newConversation("s", 1))
    }
}

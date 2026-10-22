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

class AgentCallsTest {
    private class Answers(val answer: (HttpCall) -> HttpAnswer) : Transport {
        val calls = mutableListOf<HttpCall>()

        override fun socket(sessionId: String, afterSeq: Long, listener: WebSocketListener): WebSocket = error("no socket")

        override fun request(sessionId: String, method: String, path: String, scoped: Boolean, answer: (Int, String) -> Unit) = Unit

        override suspend fun bytes(path: String): ByteArray? = null

        override suspend fun answer(call: HttpCall): HttpAnswer = answer.invoke(call).also { calls.add(call) }

        override suspend fun upload(call: HttpCall, mediaType: String, bytes: ByteArray): HttpAnswer = answer.invoke(call)
    }

    @Test
    fun anAgentsHistoryComesNewestFirstWithTheCurrentMarked() = runBlocking {
        val transport = Answers { call ->
            if (call.path == "/agents/ag/conversations") {
                HttpAnswer(200u, "application/json", """{"conversations":[{"sessionId":"c","current":true,"startedAt":1760000000000},{"sessionId":"a","current":false,"transcript":"unavailable"}]}""")
            } else {
                HttpAnswer(404u, null, "")
            }
        }
        val items = AgentCalls(transport).conversations("ag")!!
        assertEquals(listOf("c" to true, "a" to false), items.map { it.sessionId to it.current })
        assertTrue(items[1].unavailable)
        assertEquals("Transcript unavailable", items[1].title)
    }

    @Test
    fun anUnansweredHistoryIsNullNotEmpty() = runBlocking {
        assertEquals(null, AgentCalls(Answers { HttpAnswer(0u, null, "") }).conversations("ag"))
        assertEquals(null, AgentCalls(Answers { HttpAnswer(500u, null, "") }).pastAgents())
    }

    @Test
    fun pastAgentsCountTheirConversations() = runBlocking {
        val transport = Answers {
            HttpAnswer(200u, "application/json", """{"retired":[{"id":"x","name":"Gone","retiredAt":0,"pastSessions":["s"],"conversations":[]}]}""")
        }
        val past = AgentCalls(transport).pastAgents()!!.single()
        assertEquals("x" to "Gone", past.id to past.name)
        assertTrue(past.detail.endsWith("1 conversation"))
        assertEquals("/agents?retired=1", transport.calls.single().path)
    }

    @Test
    fun aRestartAnswersTheNewConversationAndAFailureCarriesTheGatewaysWords() = runBlocking {
        val ok = Answers {
            HttpAnswer(200u, "application/json", """{"agent":{"id":"ag","name":"A","createdAt":0,"updatedAt":0,"pastSessions":[],"config":{}},"session":{"id":"s2","status":"starting","cwd":"/r","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}""")
        }
        assertEquals("s2", AgentCalls(ok).restart("ag", "s1").getOrThrow())
        val gone = AgentCalls(Answers { HttpAnswer(0u, null, "") }).delete("ag", "s1")
        assertEquals("The gateway did not answer", gone.exceptionOrNull()?.message)
    }
}

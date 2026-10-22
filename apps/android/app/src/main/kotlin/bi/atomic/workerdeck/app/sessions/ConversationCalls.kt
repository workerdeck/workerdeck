package bi.atomic.workerdeck.app.sessions

import bi.atomic.workerdeck.app.gateway.GatewayException
import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.core.ffi.ConversationItem
import bi.atomic.workerdeck.core.ffi.HttpCall
import bi.atomic.workerdeck.core.ffi.PastAgent
import bi.atomic.workerdeck.core.ffi.RetireMembers
import bi.atomic.workerdeck.core.ffi.agentConversations
import bi.atomic.workerdeck.core.ffi.agentConversationsCall
import bi.atomic.workerdeck.core.ffi.createdAgent
import bi.atomic.workerdeck.core.ffi.listAgentsCall
import bi.atomic.workerdeck.core.ffi.pastAgents
import bi.atomic.workerdeck.core.ffi.restError
import bi.atomic.workerdeck.core.ffi.restartAgentCall
import bi.atomic.workerdeck.core.ffi.retireAgentCall
import bi.atomic.workerdeck.core.ffi.retiredAgentsCall
import bi.atomic.workerdeck.core.ffi.retryAgentStartCall
import bi.atomic.workerdeck.core.ffi.settleUndeliveredCall
import java.util.TimeZone

// The agent-conversation REST calls the core names, sent over a gateway; the list and the session screen share them.
class AgentCalls(private val transport: Transport) {
    // Names the conversation the caller showed, so a stale read never rotates twice. Answers the new conversation's id.
    suspend fun restart(agentId: String, shown: String): Result<String?> =
        perform(restartAgentCall(agentId, null, shown)).map { createdAgent(it)?.sessionId }

    // Delete agent: its conversations stay under Past agents and its members are released.
    suspend fun delete(agentId: String, shown: String): Result<Unit> =
        perform(retireAgentCall(agentId, RetireMembers.RELEASE, shown)).map {}

    suspend fun settleUndelivered(agentId: String, send: Boolean): Result<Unit> = perform(settleUndeliveredCall(agentId, send)).map {}

    suspend fun retryStart(agentId: String): Result<Unit> = perform(retryAgentStartCall(agentId)).map {}

    // `GET /agents`, or null when it did not answer: an unread list never reads as a deleted agent.
    suspend fun agents(): String? = transport.answer(listAgentsCall()).takeIf { it.status.toInt() == 200 }?.body

    // Null when the gateway could not answer; the sheet says so instead of showing an empty history.
    suspend fun conversations(agentId: String): List<ConversationItem>? {
        val answer = transport.answer(agentConversationsCall(agentId))
        if (answer.status.toInt() != 200) return null
        val now = System.currentTimeMillis()
        return agentConversations(answer.body, now.toDouble(), offsetMinutes(now))
    }

    suspend fun pastAgents(): List<PastAgent>? {
        val answer = transport.answer(retiredAgentsCall())
        if (answer.status.toInt() != 200) return null
        val now = System.currentTimeMillis()
        return pastAgents(answer.body, now.toDouble(), offsetMinutes(now))
    }

    private suspend fun perform(call: HttpCall): Result<String> {
        val answer = transport.answer(call)
        if (answer.status.toInt() == 0) return Result.failure(GatewayException("The gateway did not answer"))
        restError(answer.status, answer.contentType, answer.body)?.let { return Result.failure(GatewayException(it.message)) }
        return Result.success(answer.body)
    }
}

fun offsetMinutes(now: Long): Int = TimeZone.getDefault().getOffset(now) / 60_000

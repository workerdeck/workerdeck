package bi.atomic.workerdeck.app.sessions

import bi.atomic.workerdeck.app.gateway.GatewayException
import bi.atomic.workerdeck.app.gateway.Transport
import bi.atomic.workerdeck.core.ffi.ConversationItem
import bi.atomic.workerdeck.core.ffi.DiscardConfirmation
import bi.atomic.workerdeck.core.ffi.HttpCall
import bi.atomic.workerdeck.core.ffi.PastAgent
import bi.atomic.workerdeck.core.ffi.RetireMembers
import bi.atomic.workerdeck.core.ffi.conversationsCall
import bi.atomic.workerdeck.core.ffi.discardAndCutCall
import bi.atomic.workerdeck.core.ffi.discardConfirmation
import bi.atomic.workerdeck.core.ffi.newConversationCall
import bi.atomic.workerdeck.core.ffi.pastAgents
import bi.atomic.workerdeck.core.ffi.restError
import bi.atomic.workerdeck.core.ffi.retireAgentCall
import bi.atomic.workerdeck.core.ffi.retiredAgentsCall
import bi.atomic.workerdeck.core.ffi.retryConversationStartCall
import bi.atomic.workerdeck.core.ffi.sessionConversations
import bi.atomic.workerdeck.core.ffi.settlePendingPromptCall
import bi.atomic.workerdeck.core.ffi.uncertainPromptConversation
import java.util.TimeZone

// How a New conversation answered: done, refused until unconfirmed input is discarded, refused until a first message
// of unknown delivery is settled (its n), or failed.
sealed interface CutAnswer {
    data object Done : CutAnswer

    data class Discard(val confirmation: DiscardConfirmation) : CutAnswer

    data class Settle(val conversation: Long) : CutAnswer

    data class Failed(val message: String) : CutAnswer
}

// The conversation REST calls the core names, sent over a gateway; the list and the session screen share them. Every
// mutating one names the conversation the caller showed, so a stale read never cuts twice.
class ConversationCalls(private val transport: Transport) {
    suspend fun newConversation(sessionId: String, conversation: Long): CutAnswer =
        cut(newConversationCall(sessionId, conversation, null))

    suspend fun discardAndCut(sessionId: String, confirmation: DiscardConfirmation): CutAnswer =
        cut(discardAndCutCall(sessionId, confirmation.conversation, confirmation.inputRevision, null))

    private suspend fun cut(call: HttpCall): CutAnswer {
        val answer = transport.answer(call)
        val status = answer.status.toInt()
        if (status in 200..299) return CutAnswer.Done
        discardConfirmation(answer.status, answer.body)?.let { return CutAnswer.Discard(it) }
        uncertainPromptConversation(answer.status, answer.body)?.let { return CutAnswer.Settle(it) }
        val error = if (status == 0) null else restError(answer.status, answer.contentType, answer.body)
        return CutAnswer.Failed(error?.message ?: "The gateway did not answer")
    }

    // Delete agent: its conversations stay under Past agents and its members are released.
    suspend fun delete(agentId: String, conversation: Long): Result<Unit> =
        perform(retireAgentCall(agentId, RetireMembers.RELEASE, conversation)).map {}

    suspend fun settle(sessionId: String, send: Boolean, conversation: Long): Result<Unit> =
        perform(settlePendingPromptCall(sessionId, send, conversation)).map {}

    suspend fun retryStart(sessionId: String, conversation: Long): Result<Unit> =
        perform(retryConversationStartCall(sessionId, conversation)).map {}

    // The session's own conversations list, or null when it did not answer: an unread list never reads as closed.
    suspend fun conversationsBody(sessionId: String): String? =
        transport.answer(conversationsCall(sessionId)).takeIf { it.status.toInt() == 200 }?.body

    // Null when the gateway could not answer; the sheet says so instead of showing an empty history.
    suspend fun conversations(sessionId: String, title: String?): List<ConversationItem>? {
        val body = conversationsBody(sessionId) ?: return null
        val now = System.currentTimeMillis()
        return sessionConversations(body, title, now.toDouble(), offsetMinutes(now))
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
